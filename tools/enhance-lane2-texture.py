#!/usr/bin/env python3
"""Repaint Trellis-lane facial landmarks into the embedded BBModel atlas."""

from __future__ import annotations

import argparse
import base64
import io
import json
import statistics
from pathlib import Path
from typing import Any

from PIL import Image


PREFIX = "data:image/png;base64,"


def embedded_texture(model: dict[str, Any]) -> Image.Image:
    source = model["textures"][0]["source"]
    if not isinstance(source, str) or not source.startswith(PREFIX):
        raise RuntimeError("BBModel does not contain one embedded PNG")
    raw = base64.b64decode(source[len(PREFIX) :], validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        return image.convert("RGBA")


def encode_texture(image: Image.Image) -> tuple[bytes, str]:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    raw = output.getvalue()
    return raw, PREFIX + base64.b64encode(raw).decode("ascii")


def extract_reference_palette(
    reference: Image.Image,
    colors: int = 24,
) -> list[tuple[int, int, int]]:
    rgb = reference.convert("RGB")
    def data(image: Image.Image) -> list[tuple[int, int, int]]:
        if hasattr(image, "get_flattened_data"):
            return list(image.get_flattened_data())
        return list(image.getdata())

    border = (
        data(rgb.crop((0, 0, rgb.width, 1)))
        + data(rgb.crop((0, rgb.height - 1, rgb.width, rgb.height)))
        + data(rgb.crop((0, 0, 1, rgb.height)))
        + data(rgb.crop((rgb.width - 1, 0, rgb.width, rgb.height)))
    )
    background = tuple(
        round(statistics.median(pixel[channel] for pixel in border))
        for channel in range(3)
    )
    step = max(1, min(rgb.width, rgb.height) // 256)
    foreground = []
    for y in range(0, rgb.height, step):
        for x in range(0, rgb.width, step):
            pixel = rgb.getpixel((x, y))
            distance = sum(
                (pixel[channel] - background[channel]) ** 2
                for channel in range(3)
            )
            if distance > 45**2:
                foreground.append(pixel)
    if not foreground:
        raise RuntimeError("Reference foreground palette is empty")
    strip = Image.new("RGB", (len(foreground), 1))
    strip.putdata(foreground)
    quantized = strip.quantize(
        colors=colors,
        method=Image.Quantize.MAXCOVERAGE,
        dither=Image.Dither.NONE,
    )
    raw_palette = quantized.getpalette() or []
    result = []
    for count, index in quantized.getcolors() or []:
        if count <= 0:
            continue
        offset = index * 3
        candidate = tuple(raw_palette[offset : offset + 3])
        if len(candidate) == 3 and candidate not in result:
            result.append(candidate)
    return result


def harmonize_palette(
    atlas: Image.Image,
    reference: Image.Image,
    strength: float = 0.62,
) -> Image.Image:
    palette = extract_reference_palette(reference)
    output = atlas.copy()
    pixels = output.load()
    for y in range(output.height):
        for x in range(output.width):
            source = pixels[x, y]
            if source[3] == 0:
                continue
            target = min(
                palette,
                key=lambda candidate: sum(
                    (source[channel] - candidate[channel]) ** 2
                    for channel in range(3)
                ),
            )
            pixels[x, y] = (
                *(
                    round(
                        source[channel] * (1 - strength)
                        + target[channel] * strength
                    )
                    for channel in range(3)
                ),
                source[3],
            )
    return output


def color(value: Any, fallback: tuple[int, int, int]) -> tuple[int, int, int, int]:
    if (
        isinstance(value, list)
        and len(value) == 3
        and all(isinstance(item, int) and 0 <= item <= 255 for item in value)
    ):
        return value[0], value[1], value[2], 255
    return *fallback, 255


def paint_landmark(
    image: Image.Image,
    element: dict[str, Any],
    landmark: dict[str, Any],
) -> None:
    face = element["faces"].get(landmark["face"])
    if not isinstance(face, dict) or not isinstance(face.get("uv"), list):
        raise RuntimeError(
            f"{element['name']} has no {landmark['face']} texture face"
        )
    u1, v1, u2, v2 = (float(value) for value in face["uv"])
    left, right = sorted((u1, u2))
    top, bottom = sorted((v1, v2))
    width = max(1, round(right - left))
    height = max(1, round(bottom - top))
    center_uv = landmark["center_uv"]
    center_u = float(center_uv[0])
    center_v = float(center_uv[1])
    if "eye" in landmark["name"]:
        center_v = min(center_v, 0.36)
    center_x = round(u1 + center_u * (u2 - u1))
    center_y = round(v1 + center_v * (v2 - v1))
    mark_width = int(landmark["size"][0])
    mark_height = int(landmark["size"][1])
    if "eye" in landmark["name"]:
        mark_width = max(3, mark_width)
        mark_height = max(3, mark_height)
    mark_width = min(width, mark_width)
    mark_height = min(height, mark_height)
    mark_left = max(round(left), min(round(right) - mark_width, center_x - mark_width // 2))
    mark_top = max(round(top), min(round(bottom) - mark_height, center_y - mark_height // 2))
    pixels = image.load()
    fill = color(landmark.get("fill"), (10, 10, 10))
    highlight = color(landmark.get("center"), fill[:3])
    for y in range(mark_top, mark_top + mark_height):
        for x in range(mark_left, mark_left + mark_width):
            pixels[x, y] = fill
    pixels[
        mark_left + (mark_width - 1) // 2,
        mark_top + (mark_height - 1) // 2,
    ] = highlight


def enhance(
    model: dict[str, Any],
    anatomy: dict[str, Any],
    reference: Image.Image | None = None,
) -> tuple[dict[str, Any], Image.Image]:
    output = json.loads(json.dumps(model))
    atlas = embedded_texture(output)
    if reference is not None:
        atlas = harmonize_palette(atlas, reference)
    elements = {element["name"]: element for element in output["elements"]}
    for landmark in anatomy.get("landmarks", []):
        cube = elements.get(landmark.get("cube"))
        if cube is None:
            raise RuntimeError(
                f"Missing landmark cube: {landmark.get('cube')}"
            )
        paint_landmark(atlas, cube, landmark)

    _, source = encode_texture(atlas)
    output["textures"][0]["source"] = source
    output["img2blockbench"] = {
        "front_axis": "negative_z",
        "texture_density": anatomy["texture"]["density"],
        "semantic_texture_repair": {
            "version": 1,
            "landmarks_repainted": len(anatomy.get("landmarks", [])),
            "reference_palette_harmonized": reference is not None,
        },
    }
    return output, atlas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("--anatomy", required=True, type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--output-model", required=True, type=Path)
    parser.add_argument("--output-texture", required=True, type=Path)
    args = parser.parse_args()

    model = json.loads(args.model.read_text(encoding="utf-8"))
    anatomy = json.loads(args.anatomy.read_text(encoding="utf-8"))
    reference = None
    if args.reference is not None:
        with Image.open(args.reference) as image:
            reference = image.convert("RGB")
    output, atlas = enhance(model, anatomy, reference)

    args.output_model.parent.mkdir(parents=True, exist_ok=True)
    args.output_model.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    args.output_texture.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(
        args.output_texture,
        format="PNG",
        optimize=False,
        compress_level=9,
    )
    print(args.output_model)
    print(args.output_texture)


if __name__ == "__main__":
    main()
