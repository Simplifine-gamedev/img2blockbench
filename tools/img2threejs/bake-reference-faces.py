#!/usr/bin/env python3
"""Bake a Minecraft reference image onto an img2threejs cuboid specification."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage


FACE_VERTEX_INDICES = {
    "east": (4, 5, 7, 6),
    "west": (0, 2, 3, 1),
    "up": (2, 6, 7, 3),
    "down": (0, 1, 5, 4),
    "south": (1, 3, 7, 5),
    "north": (0, 4, 6, 2),
}
FACE_AXES = {
    "east": (0, 2, 1, 1),
    "west": (0, 2, 1, -1),
    "up": (1, 0, 2, 1),
    "down": (1, 0, 2, -1),
    "south": (2, 0, 1, 1),
    "north": (2, 0, 1, -1),
}
OPPOSITE_FACE = {
    "east": "west",
    "west": "east",
    "up": "down",
    "down": "up",
    "south": "north",
    "north": "south",
}
CAMERA_GRID = {
    "azimuth": [*range(-60, -19, 5), *range(20, 61, 5)],
    "elevation": list(range(10, 46, 5)),
}
PROJECTION_VERSION = 1
TEXTURE_TRANSFER_VERSION = 2


def load_compiler(root: Path) -> Any:
    path = root / "skill" / "img2blockbench" / "scripts" / "img2blockbench.py"
    module_spec = importlib.util.spec_from_file_location(
        "img2blockbench_reference_projection",
        path,
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"Unable to load compiler: {path}")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def rotation_matrix(rotation_degrees: list[float]) -> np.ndarray:
    x, y, z = np.radians(np.asarray(rotation_degrees, dtype=float))
    cosine_x, sine_x = math.cos(x), math.sin(x)
    cosine_y, sine_y = math.cos(y), math.sin(y)
    cosine_z, sine_z = math.cos(z), math.sin(z)
    rotate_x = np.asarray(
        [[1, 0, 0], [0, cosine_x, -sine_x], [0, sine_x, cosine_x]],
        dtype=float,
    )
    rotate_y = np.asarray(
        [[cosine_y, 0, sine_y], [0, 1, 0], [-sine_y, 0, cosine_y]],
        dtype=float,
    )
    rotate_z = np.asarray(
        [[cosine_z, -sine_z, 0], [sine_z, cosine_z, 0], [0, 0, 1]],
        dtype=float,
    )
    return rotate_z @ rotate_y @ rotate_x


def cube_vertices(cube: dict[str, Any]) -> np.ndarray:
    center = np.asarray(cube["center"], dtype=float)
    size = np.asarray(cube["size"], dtype=float)
    origin = np.asarray(cube.get("origin", cube["center"]), dtype=float)
    vertices = np.asarray(
        [
            [x, y, z]
            for x in (-0.5, 0.5)
            for y in (-0.5, 0.5)
            for z in (-0.5, 0.5)
        ],
        dtype=float,
    )
    vertices = vertices * size + center
    rotation = rotation_matrix(cube.get("rotation", [0, 0, 0]))
    return (vertices - origin) @ rotation.T + origin


def camera_basis(azimuth: float, elevation: float) -> tuple[np.ndarray, ...]:
    azimuth_radians = math.radians(azimuth)
    elevation_radians = math.radians(elevation)
    camera_direction = np.asarray(
        [
            math.sin(azimuth_radians) * math.cos(elevation_radians),
            math.sin(elevation_radians),
            math.cos(azimuth_radians) * math.cos(elevation_radians),
        ],
        dtype=float,
    )
    forward = -camera_direction
    right = np.cross(forward, np.asarray([0.0, 1.0, 0.0]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return camera_direction, right, up


def projected_polygons(
    cubes: list[dict[str, Any]],
    azimuth: float,
    elevation: float,
) -> list[np.ndarray]:
    _, right, up = camera_basis(azimuth, elevation)
    polygons: list[np.ndarray] = []
    for cube in cubes:
        vertices = cube_vertices(cube)
        for indices in FACE_VERTEX_INDICES.values():
            face = vertices[list(indices)]
            polygons.append(
                np.stack([face @ right, face @ up], axis=1)
            )
    return polygons


def normalized_mask(
    polygons: list[np.ndarray],
    size: int = 256,
    padding: int = 10,
) -> np.ndarray:
    points = np.concatenate(polygons)
    lower = points.min(axis=0)
    upper = points.max(axis=0)
    span = np.maximum(upper - lower, 1e-6)
    scale = (size - padding * 2) / max(span)
    center = (lower + upper) / 2
    image = Image.new("1", (size, size))
    draw = ImageDraw.Draw(image)
    for polygon in polygons:
        projected = (polygon - center) * scale + size / 2
        draw.polygon([tuple(point) for point in projected], fill=1)
    return np.asarray(image, dtype=bool)


def segment_reference(
    image: Image.Image,
    threshold: float,
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    pixels = np.asarray(image.convert("RGB"), dtype=np.float32)
    height, width, _ = pixels.shape
    edge_width = max(8, width // 12)
    edge_pixels = np.concatenate(
        [pixels[:, :edge_width, :], pixels[:, -edge_width:, :]],
        axis=1,
    )
    row_background = np.median(edge_pixels, axis=1)[:, None, :]
    distance = np.sqrt(np.square(pixels - row_background).sum(axis=2))
    mask = distance > threshold
    mask = ndimage.binary_opening(mask, iterations=1)
    mask = ndimage.binary_closing(mask, iterations=2)
    labels, _ = ndimage.label(mask)
    sizes = np.bincount(labels.ravel())
    if sizes.size <= 1:
        raise RuntimeError("Could not segment the reference object")
    sizes[0] = 0
    keep = np.flatnonzero(sizes > sizes.max() * 0.015)
    mask = np.isin(labels, keep)
    y_values, x_values = np.where(mask)
    if not len(x_values):
        raise RuntimeError("Reference foreground mask is empty")
    bounds = (
        int(x_values.min()),
        int(y_values.min()),
        int(x_values.max()) + 1,
        int(y_values.max()) + 1,
    )
    return mask, bounds


def normalized_reference_mask(
    mask: np.ndarray,
    bounds: tuple[int, int, int, int],
    size: int = 256,
    padding: int = 10,
) -> np.ndarray:
    left, top, right, bottom = bounds
    crop = Image.fromarray(mask[top:bottom, left:right])
    scale = min(
        (size - padding * 2) / crop.width,
        (size - padding * 2) / crop.height,
    )
    resized = crop.resize(
        (
            max(1, round(crop.width * scale)),
            max(1, round(crop.height * scale)),
        ),
        Image.Resampling.NEAREST,
    )
    output = Image.new("1", (size, size))
    output.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    return np.asarray(output, dtype=bool)


def mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    union = np.logical_or(left, right).sum()
    if not union:
        return 1.0
    return float(np.logical_and(left, right).sum() / union)


def solve_camera(
    cubes: list[dict[str, Any]],
    target_mask: np.ndarray,
) -> tuple[float, float, float]:
    best = (-1.0, 35.0, 20.0)
    for azimuth in CAMERA_GRID["azimuth"]:
        for elevation in CAMERA_GRID["elevation"]:
            score = mask_iou(
                target_mask,
                normalized_mask(
                    projected_polygons(cubes, azimuth, elevation)
                ),
            )
            if score > best[0]:
                best = (score, float(azimuth), float(elevation))

    _, coarse_azimuth, coarse_elevation = best
    for azimuth in np.arange(coarse_azimuth - 4, coarse_azimuth + 4.1, 1):
        for elevation in np.arange(
            max(5, coarse_elevation - 4),
            min(55, coarse_elevation + 4) + 0.1,
            1,
        ):
            score = mask_iou(
                target_mask,
                normalized_mask(
                    projected_polygons(
                        cubes,
                        float(azimuth),
                        float(elevation),
                    )
                ),
            )
            if score > best[0]:
                best = (score, float(azimuth), float(elevation))
    return best


def model_projection_transform(
    cubes: list[dict[str, Any]],
    right_vector: np.ndarray,
    up_vector: np.ndarray,
    reference_bounds: tuple[int, int, int, int],
) -> tuple[np.ndarray, float, np.ndarray]:
    vertices = np.concatenate([cube_vertices(cube) for cube in cubes])
    projected = np.stack(
        [vertices @ right_vector, vertices @ up_vector],
        axis=1,
    )
    model_lower = projected.min(axis=0)
    model_upper = projected.max(axis=0)
    model_span = np.maximum(model_upper - model_lower, 1e-6)
    left, top, right, bottom = reference_bounds
    reference_span = np.asarray([right - left, bottom - top], dtype=float)
    scale = float(min(reference_span / model_span))
    model_center = (model_lower + model_upper) / 2
    reference_center = np.asarray(
        [(left + right) / 2, (top + bottom) / 2],
        dtype=float,
    )
    return model_center, scale, reference_center


def world_to_reference(
    point: np.ndarray,
    right_vector: np.ndarray,
    up_vector: np.ndarray,
    model_center: np.ndarray,
    scale: float,
    reference_center: np.ndarray,
) -> tuple[float, float]:
    projected = np.asarray(
        [point @ right_vector, point @ up_vector],
        dtype=float,
    )
    offset = projected - model_center
    return (
        float(reference_center[0] + offset[0] * scale),
        float(reference_center[1] - offset[1] * scale),
    )


def face_point(
    cube: dict[str, Any],
    face: str,
    x: int,
    y: int,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray]:
    normal_axis, horizontal_axis, vertical_axis, normal_sign = (
        FACE_AXES[face]
    )
    center = np.asarray(cube["center"], dtype=float)
    size = np.asarray(cube["size"], dtype=float)
    origin = np.asarray(cube.get("origin", cube["center"]), dtype=float)
    point = center.copy()
    point[normal_axis] += normal_sign * size[normal_axis] / 2
    point[horizontal_axis] += (
        (x + 0.5) / width - 0.5
    ) * size[horizontal_axis]
    point[vertical_axis] += (
        0.5 - (y + 0.5) / height
    ) * size[vertical_axis]
    normal = np.zeros(3, dtype=float)
    normal[normal_axis] = normal_sign
    rotation = rotation_matrix(cube.get("rotation", [0, 0, 0]))
    return (
        rotation @ (point - origin) + origin,
        rotation @ normal,
    )


def nearest_foreground(
    mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    distance, indices = ndimage.distance_transform_edt(
        ~mask,
        return_indices=True,
    )
    return distance, indices[0], indices[1]


def fill_from_nearest(
    pixels: np.ndarray,
    valid: np.ndarray,
) -> np.ndarray:
    if not valid.any():
        return pixels
    _, indices = ndimage.distance_transform_edt(
        ~valid,
        return_indices=True,
    )
    return pixels[indices[0], indices[1]]


def hex_color(value: str) -> np.ndarray:
    return np.asarray(
        [int(value[index : index + 2], 16) for index in (1, 3, 5)],
        dtype=np.uint8,
    )


def procedural_patch(
    material: dict[str, Any],
    width: int,
    height: int,
    seed_text: str,
) -> np.ndarray:
    colors = [
        hex_color(material["base"]),
        hex_color(material["shade"]),
        hex_color(material["highlight"]),
    ]
    seed = int(hashlib.sha256(seed_text.encode()).hexdigest()[:8], 16)
    output = np.empty((height, width, 4), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            value = (
                (x * 73_856_093)
                ^ (y * 19_349_663)
                ^ seed
            ) & 0xFF
            color = colors[1] if value < 30 else colors[2] if value > 238 else colors[0]
            output[y, x, :3] = color
            output[y, x, 3] = 255
    return output


def projection_palette(
    model_id: str,
    cube: dict[str, Any],
    material: dict[str, Any],
) -> np.ndarray:
    colors = []
    reference_palette = material.get("reference_palette")
    if isinstance(reference_palette, list):
        colors.extend(
            hex_color(color).astype(float)
            for color in reference_palette
            if isinstance(color, str)
            and len(color) == 7
            and color.startswith("#")
        )
    colors.extend(
        hex_color(material[key]).astype(float)
        for key in ("base", "shade", "highlight")
    )
    if "tiger" in model_id and not any(
        token in cube["name"]
        for token in ("white", "muzzle", "chin", "eye", "nose")
    ):
        colors.append(np.asarray([23, 17, 13], dtype=float))
    return np.stack(colors)


def matches_projection_palette(
    color: np.ndarray,
    palette: np.ndarray,
    threshold: float = 58.0,
) -> bool:
    distances = np.sqrt(np.square(palette - color.astype(float)).sum(axis=1))
    return bool(distances.min() <= threshold)


def resize_patch(patch: np.ndarray, width: int, height: int) -> np.ndarray:
    image = Image.fromarray(patch, mode="RGBA")
    return np.asarray(
        image.resize((width, height), Image.Resampling.NEAREST),
        dtype=np.uint8,
    )


def data_uri(patch: np.ndarray) -> str:
    output = io.BytesIO()
    Image.fromarray(patch, mode="RGBA").save(
        output,
        format="PNG",
        optimize=False,
        compress_level=9,
    )
    return "data:image/png;base64," + base64.b64encode(
        output.getvalue()
    ).decode("ascii")


def source_texture(patch: np.ndarray) -> dict[str, Any]:
    return {
        "data_uri": data_uri(patch),
        "repeat": [1, 1],
        "offset": [0, 0],
        "center": [0, 0],
        "rotation": 0,
        "wrap": [1001, 1001],
        "flip_y": False,
    }


def preserve_threejs_albedo(
    spec: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Keep the base-color maps imported from img2threejs materials.

    ``from-threejs`` already extracts each MeshPhysicalMaterial ``map`` into
    ``material.source_texture``. Re-projecting the single reference image over
    those maps loses depth/occlusion information and creates texture smearing.
    """

    output = json.loads(json.dumps(spec))
    materials = output["materials"]
    mapped_materials = []
    missing_materials = []

    for material_name, material in materials.items():
        source = material.get("source_texture", {})
        uri = source.get("data_uri") if isinstance(source, dict) else None
        if isinstance(uri, str) and uri.startswith("data:image/png;base64,"):
            mapped_materials.append(material_name)
        else:
            missing_materials.append(material_name)

    if missing_materials:
        raise RuntimeError(
            "The imported Three.js spec is missing base-color maps for: "
            + ", ".join(missing_materials)
            + ". Use --reference-projection only as an explicit fallback."
        )

    output["texture"]["quantize_source"] = True
    output["texture"]["palette_size"] = max(
        32,
        int(output["texture"]["palette_size"]),
    )
    output.setdefault("generation", {}).update(
        {
            "lane": "threejs",
            "intermediate": "Object3D.toJSON",
            "texture_transfer": {
                "algorithm": "img2threejs-material-albedo-transfer",
                "version": TEXTURE_TRANSFER_VERSION,
                "source": "MeshPhysicalMaterial.map",
                "mapped_materials": len(mapped_materials),
                "reference_projection": False,
                "palette_quantization": output["texture"]["palette_size"],
            },
        }
    )
    output["generation"].pop("reference_texture_projection", None)

    audit = {
        "algorithm": "img2threejs-material-albedo-transfer",
        "version": TEXTURE_TRANSFER_VERSION,
        "source": "MeshPhysicalMaterial.map",
        "mapped_materials": mapped_materials,
        "mapped_material_count": len(mapped_materials),
        "reference_projection": False,
        "palette_size": output["texture"]["palette_size"],
    }
    return output, audit


def bake(
    spec: dict[str, Any],
    reference: Image.Image,
    foreground_mask: np.ndarray,
    foreground_bounds: tuple[int, int, int, int],
    compiler: Any,
    azimuth: float,
    elevation: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    output = json.loads(json.dumps(spec))
    cubes = output["cubes"]
    camera_direction, right_vector, up_vector = camera_basis(
        azimuth,
        elevation,
    )
    model_center, scale, reference_center = model_projection_transform(
        cubes,
        right_vector,
        up_vector,
        foreground_bounds,
    )
    distance, nearest_y, nearest_x = nearest_foreground(foreground_mask)
    reference_pixels = np.asarray(reference.convert("RGB"), dtype=np.uint8)
    maximum_snap_distance = max(
        foreground_bounds[2] - foreground_bounds[0],
        foreground_bounds[3] - foreground_bounds[1],
    ) * 0.018
    raw_patches: dict[tuple[str, str], tuple[np.ndarray, float]] = {}

    for cube in cubes:
        for face in compiler.FACES:
            width, height = compiler.face_dimensions(
                cube,
                face,
                output["texture"]["density"],
            )
            patch = np.zeros((height, width, 4), dtype=np.uint8)
            valid = np.zeros((height, width), dtype=bool)
            normal_axis, _, _, normal_sign = compiler.FACE_AXES[face]
            normal = np.zeros(3, dtype=float)
            normal[normal_axis] = normal_sign
            normal = rotation_matrix(
                cube.get("rotation", [0, 0, 0])
            ) @ normal
            front_facing = float(normal @ camera_direction) > 0.045
            material_name = cube.get("faces", {}).get(
                face,
                {},
            ).get("material", cube["material"])
            allowed_palette = projection_palette(
                output["id"],
                cube,
                output["materials"][material_name],
            )

            if front_facing:
                for y in range(height):
                    for x in range(width):
                        point, _ = face_point(
                            cube,
                            face,
                            x,
                            y,
                            width,
                            height,
                        )
                        image_x, image_y = world_to_reference(
                            point,
                            right_vector,
                            up_vector,
                            model_center,
                            scale,
                            reference_center,
                        )
                        sample_x = min(
                            reference.width - 1,
                            max(0, round(image_x)),
                        )
                        sample_y = min(
                            reference.height - 1,
                            max(0, round(image_y)),
                        )
                        if not foreground_mask[sample_y, sample_x]:
                            if (
                                distance[sample_y, sample_x]
                                > maximum_snap_distance
                            ):
                                continue
                            nearest_sample_y = int(
                                nearest_y[sample_y, sample_x]
                            )
                            nearest_sample_x = int(
                                nearest_x[sample_y, sample_x]
                            )
                            sample_y = nearest_sample_y
                            sample_x = nearest_sample_x
                        sampled_color = reference_pixels[
                            sample_y,
                            sample_x,
                        ]
                        if not matches_projection_palette(
                            sampled_color,
                            allowed_palette,
                        ):
                            continue
                        patch[y, x, :3] = sampled_color
                        patch[y, x, 3] = 255
                        valid[y, x] = True

            coverage = float(valid.mean())
            if coverage:
                patch = fill_from_nearest(patch, valid)
                patch[:, :, 3] = 255
            raw_patches[(cube["name"], face)] = (patch, coverage)

    projected_faces = 0
    mirrored_faces = 0
    procedural_faces = 0
    for cube in cubes:
        for face in compiler.FACES:
            patch, coverage = raw_patches[(cube["name"], face)]
            width, height = patch.shape[1], patch.shape[0]
            if coverage >= 0.12:
                final_patch = patch
                projected_faces += 1
            else:
                opposite_patch, opposite_coverage = raw_patches[
                    (cube["name"], OPPOSITE_FACE[face])
                ]
                if opposite_coverage >= 0.12:
                    final_patch = resize_patch(
                        np.flip(opposite_patch, axis=1).copy(),
                        width,
                        height,
                    )
                    mirrored_faces += 1
                else:
                    material_name = cube.get("faces", {}).get(
                        face,
                        {},
                    ).get("material", cube["material"])
                    final_patch = procedural_patch(
                        output["materials"][material_name],
                        width,
                        height,
                        f"{cube['name']}/{face}/{material_name}",
                    )
                    procedural_faces += 1
            face_override = cube.setdefault("faces", {}).setdefault(face, {})
            face_override["source_texture"] = source_texture(final_patch)

    for material in output["materials"].values():
        material.pop("source_texture", None)
    output["texture"]["quantize_source"] = True
    output["texture"]["palette_size"] = max(
        32,
        int(output["texture"]["palette_size"]),
    )
    output.setdefault("generation", {}).update(
        {
            "lane": "threejs",
            "intermediate": "Object3D.toJSON",
            "reference_texture_projection": {
                "algorithm": "orthographic-cuboid-face-projection",
                "version": PROJECTION_VERSION,
                "camera": {
                    "azimuth_degrees": round(azimuth, 3),
                    "elevation_degrees": round(elevation, 3),
                },
                "unseen_face_policy": "mirror-opposite-visible-face",
                "palette_quantization": output["texture"]["palette_size"],
            },
        }
    )
    audit = {
        "algorithm": "orthographic-cuboid-face-projection",
        "version": PROJECTION_VERSION,
        "camera": {
            "azimuth_degrees": round(azimuth, 3),
            "elevation_degrees": round(elevation, 3),
        },
        "reference_foreground_bounds": list(foreground_bounds),
        "faces": {
            "projected": projected_faces,
            "mirrored": mirrored_faces,
            "procedural_fallback": procedural_faces,
            "total": len(cubes) * len(compiler.FACES),
        },
        "unseen_face_policy": "mirror-opposite-visible-face",
        "palette_size": output["texture"]["palette_size"],
    }
    return output, audit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--output-spec", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--foreground-threshold", type=float, default=58.0)
    parser.add_argument("--azimuth", type=float)
    parser.add_argument("--elevation", type=float)
    parser.add_argument(
        "--reference-projection",
        action="store_true",
        help=(
            "Replace imported img2threejs albedo maps with experimental "
            "single-view reference projection."
        ),
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    compiler = load_compiler(root)
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    with Image.open(args.reference) as source:
        reference = source.convert("RGB")
    if args.reference_projection:
        foreground_mask, foreground_bounds = segment_reference(
            reference,
            args.foreground_threshold,
        )
        target_mask = normalized_reference_mask(
            foreground_mask,
            foreground_bounds,
        )
        if args.azimuth is None or args.elevation is None:
            camera_score, azimuth, elevation = solve_camera(
                spec["cubes"],
                target_mask,
            )
        else:
            azimuth = args.azimuth
            elevation = args.elevation
            camera_score = mask_iou(
                target_mask,
                normalized_mask(
                    projected_polygons(spec["cubes"], azimuth, elevation)
                ),
            )

        output, audit = bake(
            spec,
            reference,
            foreground_mask,
            foreground_bounds,
            compiler,
            azimuth,
            elevation,
        )
        audit["camera_silhouette_iou"] = round(camera_score, 6)
        audit["foreground_threshold"] = args.foreground_threshold
    else:
        output, audit = preserve_threejs_albedo(spec)

    output["reference"]["image"] = Path(
        os.path.relpath(
            args.reference.resolve(),
            args.output_spec.parent.resolve(),
        )
    ).as_posix()
    audit["reference_sha256"] = hashlib.sha256(
        args.reference.read_bytes()
    ).hexdigest()

    errors = compiler.validate_spec(output, strict=True)
    if errors:
        raise RuntimeError(
            "Projected specification is invalid:\n"
            + "\n".join(f"- {error}" for error in errors)
        )
    args.output_spec.parent.mkdir(parents=True, exist_ok=True)
    args.output_spec.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    args.audit.write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output_spec)
    print(args.audit)


if __name__ == "__main__":
    main()
