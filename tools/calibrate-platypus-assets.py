#!/usr/bin/env python3
"""Calibrate the benchmark platypus bill and remove duplicate Trellis eyes."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
TEXTURE_PREFIX = "data:image/png;base64,"
LANE2_MODELS = (
    ROOT / "examples/platypus/lane2/platypus.bbmodel",
    ROOT / "examples/platypus/build/platypus.bbmodel",
    ROOT / "demo/public/models/platypus-lane2.bbmodel",
)
LANE2_TEXTURES = (
    ROOT / "examples/platypus/lane2/platypus.png",
    ROOT / "examples/platypus/build/platypus.png",
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def decode_texture(model: dict[str, Any]) -> Image.Image:
    source = model["textures"][0]["source"]
    if not source.startswith(TEXTURE_PREFIX):
        raise RuntimeError("Expected an embedded PNG texture")
    raw = base64.b64decode(source[len(TEXTURE_PREFIX) :], validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        return image.convert("RGBA")


def encode_texture(image: Image.Image) -> tuple[bytes, str]:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    raw = output.getvalue()
    return raw, TEXTURE_PREFIX + base64.b64encode(raw).decode("ascii")


def set_element_width(
    model: dict[str, Any],
    element_name: str,
    width: float,
) -> None:
    element = next(
        item for item in model["elements"] if item.get("name") == element_name
    )
    center = (float(element["from"][0]) + float(element["to"][0])) / 2
    element["from"][0] = center - width / 2
    element["to"][0] = center + width / 2
    target_pixels = round(width * 2)
    for face_name in ("north", "south", "up", "down"):
        uv = element["faces"][face_name]["uv"]
        low, high = sorted((float(uv[0]), float(uv[2])))
        trim = round(high - low) - target_pixels
        if trim <= 0:
            continue
        new_low = low + trim // 2
        new_high = high - (trim - trim // 2)
        if uv[0] <= uv[2]:
            uv[0], uv[2] = new_low, new_high
        else:
            uv[0], uv[2] = new_high, new_low


def is_eye_center(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, alpha = pixel
    return alpha > 0 and red > 220 and green > 220 and blue > 210


def clear_duplicate_eyes(
    atlas: Image.Image,
    head: dict[str, Any],
) -> None:
    pixels = atlas.load()
    for face_name in ("west", "east"):
        u1, v1, u2, v2 = head["faces"][face_name]["uv"]
        left, right = sorted((round(u1), round(u2)))
        top, bottom = sorted((round(v1), round(v2)))
        centers = [
            (x, y)
            for y in range(top, bottom)
            for x in range(left, right)
            if is_eye_center(pixels[x, y])
        ]
        if len(centers) < 2:
            continue
        keep = min(centers, key=lambda point: point[1])
        for center_x, center_y in centers:
            if (center_x, center_y) == keep:
                continue
            border = []
            for y in range(center_y - 2, center_y + 3):
                for x in range(center_x - 2, center_x + 3):
                    if abs(x - center_x) <= 1 and abs(y - center_y) <= 1:
                        continue
                    candidate = pixels[x, y]
                    if (
                        candidate[3] > 0
                        and max(candidate[:3]) < 210
                        and min(candidate[:3]) > 35
                    ):
                        border.append(candidate)
            replacement = (
                tuple(
                    sorted(pixel[channel] for pixel in border)[len(border) // 2]
                    for channel in range(4)
                )
                if border
                else (130, 98, 61, 255)
            )
            for y in range(center_y - 1, center_y + 2):
                for x in range(center_x - 1, center_x + 2):
                    pixels[x, y] = replacement


def update_lane2() -> None:
    canonical = load_json(LANE2_MODELS[0])
    set_element_width(canonical, "bill_upper", 8.5)
    set_element_width(canonical, "bill_lower", 8.0)
    atlas = decode_texture(canonical)
    head = next(
        element
        for element in canonical["elements"]
        if element.get("name") == "head_main"
    )
    clear_duplicate_eyes(atlas, head)
    texture_bytes, texture_source = encode_texture(atlas)
    canonical["textures"][0]["source"] = texture_source

    for path in LANE2_MODELS:
        save_json(path, canonical)
    for path in LANE2_TEXTURES:
        path.write_bytes(texture_bytes)

    geometry_path = ROOT / "examples/platypus/lane2/platypus.geo.json"
    geometry = load_json(geometry_path)
    bones = geometry["minecraft:geometry"][0]["bones"]
    bill = next(bone for bone in bones if bone.get("name") == "bill")
    for cube, width in zip(bill["cubes"], (8.5, 8.0), strict=True):
        center = float(cube["origin"][0]) + float(cube["size"][0]) / 2
        cube["origin"][0] = center - width / 2
        cube["size"][0] = width
        target_pixels = round(width * 2)
        for face_name in ("north", "south", "up", "down"):
            face = cube["uv"][face_name]
            trim = round(face["uv_size"][0]) - target_pixels
            if trim <= 0:
                continue
            face["uv"][0] += trim // 2
            face["uv_size"][0] = target_pixels
    save_json(geometry_path, geometry)


def update_scene_component(
    component: dict[str, Any],
    width: float,
) -> None:
    component["matrix"][0] = width

    def update_metadata(value: Any) -> None:
        if isinstance(value, dict):
            if (
                value.get("animationRole") in {"bill_base", "bill_tip"}
                and isinstance(value.get("collider"), dict)
            ):
                value["collider"]["scale"][0] = width
            if value.get("id") in {"bill_base", "bill_tip"}:
                if isinstance(value.get("dimensions"), dict):
                    value["dimensions"]["width"] = width
                if isinstance(value.get("transform"), dict):
                    value["transform"]["scale"][0] = width
            for child in value.values():
                update_metadata(child)
        elif isinstance(value, list):
            for child in value:
                update_metadata(child)

    update_metadata(component)


def update_lane3_scene() -> None:
    scene_paths = (
        ROOT / "examples/platypus/lane3/platypus.img2threejs.three.json",
        ROOT / "demo/public/models/platypus-lane3.three.json",
    )
    for path in scene_paths:
        scene = load_json(path)
        components = {
            component.get("name"): component
            for component in scene["object"]["children"]
        }
        update_scene_component(components["Bill base__pivot"], 7.0)
        update_scene_component(components["Bill tip__pivot"], 7.5)
        save_json(path, scene)


def update_generated_factory() -> None:
    path = (
        ROOT
        / "examples/platypus/lane3"
        / "createMinecraftPlatypusModel.generated.ts"
    )
    lines = path.read_text(encoding="utf-8").splitlines()
    output = []
    for line in lines:
        if any(
            marker in line
            for marker in (
                "node_bill_base",
                "mesh_bill_base",
                'colliders["bill_base"]',
            )
        ):
            line = line.replace("9.5", "7.0")
        if any(
            marker in line
            for marker in (
                "node_bill_tip",
                "mesh_bill_tip",
                'colliders["bill_tip"]',
            )
        ):
            line = line.replace("10.5", "7.5")
        output.append(line)
    path.write_text("\n".join(output) + "\n", encoding="utf-8")


def main() -> None:
    update_lane2()
    update_lane3_scene()
    update_generated_factory()


if __name__ == "__main__":
    main()
