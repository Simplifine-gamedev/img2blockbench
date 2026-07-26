#!/usr/bin/env python3
"""Measure structural and texture quality across the 15 benchmark BBModels."""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import re
from pathlib import Path
from typing import Any

from PIL import Image


ANIMALS = ("platypus", "chimpanzee", "elephant", "tiger", "coyote")
LANES = ("lane1", "lane2", "lane3")
FACE_AXES = {
    "east": (2, 1),
    "west": (2, 1),
    "up": (0, 2),
    "down": (0, 2),
    "south": (0, 1),
    "north": (0, 1),
}
FLAT_DETAIL = re.compile(
    r"(?:^|_)(?:eye|pupil|glint|nostril|brow|stripe)(?:_|$)"
)


def model_path(root: Path, animal: str, lane: str) -> Path:
    if lane == "lane3":
        return (
            root
            / "examples"
            / animal
            / lane
            / "blockbench"
            / f"{animal}-lane3.bbmodel"
        )
    return root / "examples" / animal / lane / f"{animal}.bbmodel"


def landmark_count(root: Path, animal: str, lane: str) -> int:
    if lane == "lane1":
        path = root / "examples" / animal / "model-spec.json"
    elif lane == "lane2":
        path = root / "examples" / animal / lane / "anatomy-spec.json"
    else:
        path = root / "examples" / animal / lane / "model-spec.json"
    return len(json.loads(path.read_text(encoding="utf-8")).get("landmarks", []))


def atlas(model: dict[str, Any]) -> Image.Image:
    source = model["textures"][0]["source"]
    raw = base64.b64decode(source.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        return image.convert("RGBA")


def entropy(colors: list[tuple[int, int, int, int]]) -> float:
    counts: dict[tuple[int, int, int, int], int] = {}
    for value in colors:
        counts[value] = counts.get(value, 0) + 1
    total = len(colors)
    return -sum(
        (count / total) * math.log2(count / total)
        for count in counts.values()
    )


def image_data(image: Image.Image) -> list[tuple[int, int, int, int]]:
    if hasattr(image, "get_flattened_data"):
        return list(image.get_flattened_data())
    return list(image.getdata())


def edge_change(image: Image.Image) -> float:
    pixels = image.load()
    changes = 0
    comparisons = 0
    for y in range(image.height):
        for x in range(image.width):
            if x + 1 < image.width:
                comparisons += 1
                changes += pixels[x, y] != pixels[x + 1, y]
            if y + 1 < image.height:
                comparisons += 1
                changes += pixels[x, y] != pixels[x, y + 1]
    return changes / comparisons if comparisons else 0.0


def face_patch(
    texture: Image.Image,
    face: dict[str, Any],
) -> Image.Image | None:
    uv = face.get("uv")
    if not isinstance(uv, list) or len(uv) != 4:
        return None
    left, right = sorted((round(float(uv[0])), round(float(uv[2]))))
    top, bottom = sorted((round(float(uv[1])), round(float(uv[3]))))
    if right <= left or bottom <= top:
        return None
    return texture.crop((left, top, right, bottom))


def inspect_model(
    root: Path,
    animal: str,
    lane: str,
) -> dict[str, Any]:
    path = model_path(root, animal, lane)
    model = json.loads(path.read_text(encoding="utf-8"))
    texture = atlas(model)
    face_entropies = []
    face_unique = []
    face_edges = []
    density_samples = []
    density_faces = []

    for element in model["elements"]:
        size = [
            float(element["to"][axis]) - float(element["from"][axis])
            for axis in range(3)
        ]
        for face_name, face in element.get("faces", {}).items():
            patch = face_patch(texture, face)
            if patch is None:
                continue
            colors = image_data(patch)
            face_entropies.append(entropy(colors))
            face_unique.append(len(set(colors)))
            face_edges.append(edge_change(patch))
            u_axis, v_axis = FACE_AXES[face_name]
            density_u = patch.width / max(size[u_axis], 1e-9)
            density_v = patch.height / max(size[v_axis], 1e-9)
            density_samples.extend((density_u, density_v))
            density_faces.append(
                (
                    element["name"],
                    face_name,
                    density_u,
                    density_v,
                )
            )

    ordered = sorted(density_samples)
    median_density = ordered[len(ordered) // 2]
    outliers = [
        {
            "cube": cube,
            "face": face,
            "density": [round(density_u, 4), round(density_v, 4)],
        }
        for cube, face, density_u, density_v in density_faces
        if abs(density_u / median_density - 1) > 0.15
        or abs(density_v / median_density - 1) > 0.15
    ]
    detail_cubes = [
        element["name"]
        for element in model["elements"]
        if FLAT_DETAIL.search(element["name"])
    ]
    return {
        "cuboids": len(model["elements"]),
        "groups": len(model.get("outliner", [])),
        "texture_size": [texture.width, texture.height],
        "texture_landmarks": landmark_count(root, animal, lane),
        "flat_detail_cuboids": detail_cubes,
        "uv_density_median": round(median_density, 4),
        "uv_density_outliers": outliers,
        "texture": {
            "mean_entropy": round(sum(face_entropies) / len(face_entropies), 4),
            "median_unique_colors": sorted(face_unique)[len(face_unique) // 2],
            "flat_faces_percent": round(
                100 * sum(value <= 3 for value in face_unique) / len(face_unique),
                2,
            ),
            "mean_edge_change_percent": round(
                100 * sum(face_edges) / len(face_edges),
                2,
            ),
        },
        "front_axis": model.get("img2blockbench", {}).get("front_axis"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()

    models = {
        animal: {
            lane: inspect_model(root, animal, lane)
            for lane in LANES
        }
        for animal in ANIMALS
    }
    aggregate = {}
    for lane in LANES:
        rows = [models[animal][lane] for animal in ANIMALS]
        aggregate[lane] = {
            "average_cuboids": round(
                sum(row["cuboids"] for row in rows) / len(rows),
                2,
            ),
            "uv_density_outlier_faces": sum(
                len(row["uv_density_outliers"]) for row in rows
            ),
            "flat_detail_cuboids": sum(
                len(row["flat_detail_cuboids"]) for row in rows
            ),
            "texture_landmarks": sum(
                row["texture_landmarks"] for row in rows
            ),
            "mean_texture_entropy": round(
                sum(row["texture"]["mean_entropy"] for row in rows)
                / len(rows),
                4,
            ),
            "mean_flat_faces_percent": round(
                sum(row["texture"]["flat_faces_percent"] for row in rows)
                / len(rows),
                2,
            ),
            "mean_edge_change_percent": round(
                sum(row["texture"]["mean_edge_change_percent"] for row in rows)
                / len(rows),
                2,
            ),
        }

    output = {
        "schema_version": 1,
        "animals": list(ANIMALS),
        "lanes": list(LANES),
        "aggregate": aggregate,
        "models": models,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output)


if __name__ == "__main__":
    main()
