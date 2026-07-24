#!/usr/bin/env python3
"""Measure multi-view silhouette overlap between a source mesh and a .bbmodel."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from PIL import Image, ImageDraw


CUBE_TRIANGLES = np.array(
    [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
    ],
    dtype=np.int64,
)

VIEW_BASES = {
    "front": np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]),
    "side": np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]]),
    "top": np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]),
    "isometric": np.array(
        [
            [math.sqrt(0.5), 0.0, -math.sqrt(0.5)],
            [math.sqrt(1.0 / 6.0), math.sqrt(2.0 / 3.0), math.sqrt(1.0 / 6.0)],
        ]
    ),
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rotation_matrix_xyz_for_blockbench(rotation: list[float]) -> np.ndarray:
    """Mirror the demo's Three.js ZYX Euler order."""
    x, y, z = np.radians(np.asarray(rotation, dtype=float))
    rx = np.array(
        [[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]]
    )
    ry = np.array(
        [[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]]
    )
    rz = np.array(
        [[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]]
    )
    return rx @ ry @ rz


def load_source_mesh(path: Path, canonical_transform: list[float]) -> tuple[np.ndarray, np.ndarray]:
    loaded = trimesh.load(path, force="scene")
    meshes: list[trimesh.Trimesh] = []
    for node_name in loaded.graph.nodes_geometry:
        transform, geometry_name = loaded.graph[node_name]
        geometry = loaded.geometry[geometry_name]
        if not isinstance(geometry, trimesh.Trimesh):
            continue
        mesh = geometry.copy()
        mesh.apply_transform(transform)
        meshes.append(mesh)
    if not meshes:
        raise ValueError(f"no triangle geometry found in {path}")

    source = trimesh.util.concatenate(meshes)
    transform = np.asarray(canonical_transform, dtype=float).reshape(4, 4)
    vertices = trimesh.transform_points(np.asarray(source.vertices), transform)
    return vertices, np.asarray(source.faces, dtype=np.int64)


def load_blockbench_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    model = read_json(path)
    vertices: list[np.ndarray] = []
    triangles: list[np.ndarray] = []

    for element in model.get("elements", []):
        if element.get("type") != "cube":
            continue
        lower = np.asarray(element["from"], dtype=float)
        upper = np.asarray(element["to"], dtype=float)
        corners = np.array(
            [
                [lower[0], lower[1], lower[2]],
                [upper[0], lower[1], lower[2]],
                [upper[0], upper[1], lower[2]],
                [lower[0], upper[1], lower[2]],
                [lower[0], lower[1], upper[2]],
                [upper[0], lower[1], upper[2]],
                [upper[0], upper[1], upper[2]],
                [lower[0], upper[1], upper[2]],
            ]
        )
        origin = np.asarray(element.get("origin", (lower + upper) / 2), dtype=float)
        rotation = rotation_matrix_xyz_for_blockbench(element.get("rotation", [0, 0, 0]))
        corners = (rotation @ (corners - origin).T).T + origin
        offset = len(vertices) * 8
        vertices.append(corners)
        triangles.append(CUBE_TRIANGLES + offset)

    if not vertices:
        raise ValueError(f"no cuboids found in {path}")
    return np.concatenate(vertices), np.concatenate(triangles)


def projected(vertices: np.ndarray, basis: np.ndarray) -> np.ndarray:
    return vertices @ basis.T


def rasterize(
    points: np.ndarray,
    triangles: np.ndarray,
    bounds: tuple[np.ndarray, np.ndarray],
    resolution: int,
    padding: int,
) -> np.ndarray:
    lower, upper = bounds
    span = np.maximum(upper - lower, 1e-9)
    available = resolution - 2 * padding
    scale = min(available / span[0], available / span[1])
    centered_lower = (lower + upper) / 2
    pixels = (points - centered_lower) * scale
    pixels[:, 0] += resolution / 2
    pixels[:, 1] = resolution / 2 - pixels[:, 1]

    mask_image = Image.new("1", (resolution, resolution), 0)
    draw = ImageDraw.Draw(mask_image)
    for triangle in triangles:
        draw.polygon([tuple(pixels[index]) for index in triangle], fill=1)
    return np.asarray(mask_image, dtype=bool)


def audit_view(
    source_vertices: np.ndarray,
    source_triangles: np.ndarray,
    model_vertices: np.ndarray,
    model_triangles: np.ndarray,
    basis: np.ndarray,
    resolution: int,
    padding: int,
) -> tuple[dict[str, float | int], np.ndarray]:
    source_points = projected(source_vertices, basis)
    model_points = projected(model_vertices, basis)
    combined = np.concatenate((source_points, model_points))
    bounds = (combined.min(axis=0), combined.max(axis=0))
    source_mask = rasterize(source_points, source_triangles, bounds, resolution, padding)
    model_mask = rasterize(model_points, model_triangles, bounds, resolution, padding)
    intersection = source_mask & model_mask
    union = source_mask | model_mask

    source_pixels = int(source_mask.sum())
    model_pixels = int(model_mask.sum())
    intersection_pixels = int(intersection.sum())
    union_pixels = int(union.sum())
    metrics: dict[str, float | int] = {
        "iou": round(intersection_pixels / max(union_pixels, 1), 4),
        "source_coverage": round(intersection_pixels / max(source_pixels, 1), 4),
        "model_precision": round(intersection_pixels / max(model_pixels, 1), 4),
        "source_pixels": source_pixels,
        "model_pixels": model_pixels,
        "intersection_pixels": intersection_pixels,
        "union_pixels": union_pixels,
    }

    comparison = np.zeros((resolution, resolution, 3), dtype=np.uint8)
    comparison[source_mask] = (37, 190, 221)
    comparison[model_mask] = (246, 126, 43)
    comparison[intersection] = (248, 250, 252)
    return metrics, comparison


def comparison_sheet(images: dict[str, np.ndarray]) -> Image.Image:
    tile_size = next(iter(images.values())).shape[0]
    header = 34
    sheet = Image.new("RGB", (tile_size * 2, (tile_size + header) * 2), "#071019")
    for index, (name, array) in enumerate(images.items()):
        x = (index % 2) * tile_size
        y = (index // 2) * (tile_size + header)
        sheet.paste(Image.fromarray(array), (x, y + header))
        draw = ImageDraw.Draw(sheet)
        draw.text((x + 12, y + 10), name.upper(), fill="#eaf3f8")
    return sheet


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Source GLB/GLTF/OBJ")
    parser.add_argument("--spec", type=Path, required=True, help="Anatomy spec with canonical_transform")
    parser.add_argument("--bbmodel", type=Path, required=True, help="Generated Blockbench model")
    parser.add_argument("--json", type=Path, required=True, help="Output metrics JSON")
    parser.add_argument("--sheet", type=Path, help="Optional color-coded comparison sheet")
    parser.add_argument("--resolution", type=int, default=512)
    args = parser.parse_args()

    if args.resolution < 128:
        parser.error("--resolution must be at least 128")
    spec = read_json(args.spec)
    transform = spec.get("canonical_transform")
    if not isinstance(transform, list) or len(transform) != 16:
        parser.error("spec canonical_transform must contain 16 numbers")

    source_vertices, source_triangles = load_source_mesh(args.source, transform)
    model_vertices, model_triangles = load_blockbench_mesh(args.bbmodel)
    padding = max(8, args.resolution // 24)

    views: dict[str, dict[str, float | int]] = {}
    images: dict[str, np.ndarray] = {}
    for name, basis in VIEW_BASES.items():
        views[name], images[name] = audit_view(
            source_vertices,
            source_triangles,
            model_vertices,
            model_triangles,
            basis,
            args.resolution,
            padding,
        )

    mean_iou = float(np.mean([view["iou"] for view in views.values()]))
    mean_source_coverage = float(
        np.mean([view["source_coverage"] for view in views.values()])
    )
    mean_model_precision = float(
        np.mean([view["model_precision"] for view in views.values()])
    )
    result = {
        "schema_version": 1,
        "method": "orthographic triangle-silhouette rasterization",
        "legend": {
            "source_only": "#25BEDD",
            "model_only": "#F67E2B",
            "overlap": "#F8FAFC",
        },
        "inputs": {
            "source": str(args.source),
            "source_sha256": sha256_file(args.source),
            "spec": str(args.spec),
            "spec_sha256": sha256_file(args.spec),
            "bbmodel": str(args.bbmodel),
            "bbmodel_sha256": sha256_file(args.bbmodel),
        },
        "resolution": args.resolution,
        "summary": {
            "mean_iou": round(mean_iou, 4),
            "mean_source_coverage": round(mean_source_coverage, 4),
            "mean_model_precision": round(mean_model_precision, 4),
        },
        "views": views,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.sheet:
        args.sheet.parent.mkdir(parents=True, exist_ok=True)
        comparison_sheet(images).save(args.sheet)
    print(json.dumps(result["summary"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
