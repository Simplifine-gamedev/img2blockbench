#!/usr/bin/env python3
"""Deterministic compiler for agent-authored Minecraft model specifications."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import re
import sys
import uuid
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image


VERSION = "0.1.0"
SCHEMA_VERSION = 1
FACES = ("north", "east", "south", "west", "up", "down")
FACE_AXES = {
    "east": (0, 2, 1, 1),
    "west": (0, 2, 1, -1),
    "up": (1, 0, 2, 1),
    "down": (1, 0, 2, -1),
    "south": (2, 0, 1, 1),
    "north": (2, 0, 1, -1),
}
PATTERNS = {"solid", "dither", "stripes", "spots", "gradient"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
NAMESPACE = uuid.UUID("ea6903e8-4e53-4fc1-9713-a6f1937a9c03")


class ModelSpecError(ValueError):
    """Raised when a model specification or generated model is invalid."""


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ModelSpecError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ModelSpecError(f"invalid JSON in {path}: {exc}") from exc


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def stable_uuid(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE, "/".join(parts)))


def finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def valid_vector(
    value: Any,
    length: int,
    label: str,
    errors: list[str],
    *,
    positive: bool = False,
) -> bool:
    if not isinstance(value, list) or len(value) != length:
        errors.append(f"{label} must be a {length}-number array")
        return False
    if not all(finite_number(item) for item in value):
        errors.append(f"{label} must contain finite numbers")
        return False
    if positive and not all(float(item) > 0 for item in value):
        errors.append(f"{label} values must be positive")
        return False
    return True


def validate_spec(spec: Any, *, strict: bool = False) -> list[str]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return ["model specification must be a JSON object"]

    require(spec.get("schema_version") == SCHEMA_VERSION, "schema_version must be 1", errors)
    model_id = spec.get("id")
    require(isinstance(model_id, str) and bool(ID_RE.fullmatch(model_id)), "id is invalid", errors)

    reference = spec.get("reference")
    if not isinstance(reference, dict):
        errors.append("reference must be an object")
    else:
        require(isinstance(reference.get("image"), str) and bool(reference["image"]), "reference.image is required", errors)
        require(isinstance(reference.get("sha256"), str) and bool(SHA_RE.fullmatch(reference["sha256"])), "reference.sha256 must be lowercase SHA-256", errors)
        require(isinstance(reference.get("width"), int) and reference["width"] > 0, "reference.width must be a positive integer", errors)
        require(isinstance(reference.get("height"), int) and reference["height"] > 0, "reference.height must be a positive integer", errors)

    subject = spec.get("subject")
    if not isinstance(subject, dict):
        errors.append("subject must be an object")
    else:
        require(isinstance(subject.get("type"), str) and bool(subject["type"]), "subject.type is required", errors)
        require(isinstance(subject.get("description"), str) and bool(subject["description"]), "subject.description is required", errors)
        require(subject.get("symmetry") in {"bilateral", "radial", "asymmetric", "none"}, "subject.symmetry is invalid", errors)
        uncertainties = subject.get("uncertainties")
        require(isinstance(uncertainties, list) and all(isinstance(item, str) and item for item in uncertainties), "subject.uncertainties must be a string array", errors)
        if strict:
            require(bool(uncertainties), "strict: record at least one uncertainty or 'none identified'", errors)

    quality = spec.get("quality_contract")
    target_min = target_max = None
    if not isinstance(quality, dict):
        errors.append("quality_contract must be an object")
    else:
        require(quality.get("complexity") in {"simple", "moderate", "complex"}, "quality_contract.complexity is invalid", errors)
        target = quality.get("target_cuboids")
        if (
            isinstance(target, list)
            and len(target) == 2
            and all(isinstance(item, int) and not isinstance(item, bool) for item in target)
            and 1 <= target[0] <= target[1] <= 96
        ):
            target_min, target_max = target
        else:
            errors.append("quality_contract.target_cuboids must be [min, max] within 1..96")
        for key in ("identity_features", "required_views", "review_targets"):
            value = quality.get(key)
            require(isinstance(value, list) and all(isinstance(item, str) and item for item in value), f"quality_contract.{key} must be a string array", errors)
            if strict:
                require(bool(value), f"strict: quality_contract.{key} cannot be empty", errors)

    texture = spec.get("texture")
    if not isinstance(texture, dict):
        errors.append("texture must be an object")
    else:
        require(texture.get("density") in {1, 2, 4}, "texture.density must be 1, 2, or 4", errors)
        require(isinstance(texture.get("palette_size"), int) and 4 <= texture["palette_size"] <= 64, "texture.palette_size must be 4..64", errors)
        require(isinstance(texture.get("gutter"), int) and 1 <= texture["gutter"] <= 4, "texture.gutter must be 1..4", errors)
        require(texture.get("atlas_size") in {16, 32, 64, 128, 256, 512}, "texture.atlas_size must be a power of two from 16..512", errors)
        require(
            "quantize_source" not in texture
            or isinstance(texture["quantize_source"], bool),
            "texture.quantize_source must be boolean",
            errors,
        )

    materials = spec.get("materials")
    material_names: set[str] = set()
    if not isinstance(materials, dict) or not materials:
        errors.append("materials must be a non-empty object")
    else:
        material_names = set(materials)
        for name, material in materials.items():
            label = f"materials.{name}"
            require(isinstance(name, str) and bool(ID_RE.fullmatch(name)), f"{label} name is invalid", errors)
            if not isinstance(material, dict):
                errors.append(f"{label} must be an object")
                continue
            for color_key in ("base", "shade", "highlight"):
                color = material.get(color_key)
                require(isinstance(color, str) and bool(HEX_RE.fullmatch(color)), f"{label}.{color_key} must be #RRGGBB", errors)
            require(material.get("pattern") in PATTERNS, f"{label}.pattern is invalid", errors)
            require(isinstance(material.get("pattern_scale"), int) and 1 <= material["pattern_scale"] <= 16, f"{label}.pattern_scale must be 1..16", errors)
            source_texture = material.get("source_texture")
            if source_texture is not None:
                if not isinstance(source_texture, dict):
                    errors.append(f"{label}.source_texture must be an object")
                else:
                    data_uri = source_texture.get("data_uri")
                    require(
                        isinstance(data_uri, str)
                        and data_uri.startswith("data:image/png;base64,"),
                        f"{label}.source_texture.data_uri must be an embedded PNG",
                        errors,
                    )
                    valid_vector(
                        source_texture.get("repeat"),
                        2,
                        f"{label}.source_texture.repeat",
                        errors,
                        positive=True,
                    )
                    valid_vector(
                        source_texture.get("offset"),
                        2,
                        f"{label}.source_texture.offset",
                        errors,
                    )
                    valid_vector(
                        source_texture.get("center"),
                        2,
                        f"{label}.source_texture.center",
                        errors,
                    )
                    require(
                        finite_number(source_texture.get("rotation")),
                        f"{label}.source_texture.rotation must be finite",
                        errors,
                    )
                    wrap = source_texture.get("wrap")
                    require(
                        isinstance(wrap, list)
                        and len(wrap) == 2
                        and all(value in {1000, 1001, 1002} for value in wrap),
                        f"{label}.source_texture.wrap is invalid",
                        errors,
                    )
                    require(
                        isinstance(source_texture.get("flip_y"), bool),
                        f"{label}.source_texture.flip_y must be boolean",
                        errors,
                    )

    bones = spec.get("bones")
    bone_names: set[str] = set()
    parent_by_bone: dict[str, str | None] = {}
    if not isinstance(bones, list) or not bones:
        errors.append("bones must be a non-empty array")
    else:
        for index, bone in enumerate(bones):
            label = f"bones[{index}]"
            if not isinstance(bone, dict):
                errors.append(f"{label} must be an object")
                continue
            name = bone.get("name")
            require(isinstance(name, str) and bool(ID_RE.fullmatch(name)), f"{label}.name is invalid", errors)
            if isinstance(name, str):
                require(name not in bone_names, f"duplicate bone name: {name}", errors)
                bone_names.add(name)
                parent_by_bone[name] = bone.get("parent")
            require(bone.get("parent") is None or isinstance(bone.get("parent"), str), f"{label}.parent must be a bone name or null", errors)
            valid_vector(bone.get("pivot"), 3, f"{label}.pivot", errors)
        roots = [name for name, parent in parent_by_bone.items() if parent is None]
        require(len(roots) == 1, "bones must contain exactly one root", errors)
        for name, parent in parent_by_bone.items():
            require(parent is None or parent in bone_names, f"bone {name} references missing parent {parent}", errors)
        for name in bone_names:
            seen: set[str] = set()
            current: str | None = name
            while current is not None and current in parent_by_bone:
                if current in seen:
                    errors.append(f"bone cycle detected at {current}")
                    break
                seen.add(current)
                current = parent_by_bone[current]

    cubes = spec.get("cubes")
    cube_names: set[str] = set()
    if not isinstance(cubes, list) or not 1 <= len(cubes) <= 96:
        errors.append("cubes must contain 1..96 cuboids")
        cubes = [] if not isinstance(cubes, list) else cubes
    for index, cube in enumerate(cubes):
        label = f"cubes[{index}]"
        if not isinstance(cube, dict):
            errors.append(f"{label} must be an object")
            continue
        name = cube.get("name")
        require(isinstance(name, str) and bool(ID_RE.fullmatch(name)), f"{label}.name is invalid", errors)
        if isinstance(name, str):
            require(name not in cube_names, f"duplicate cube name: {name}", errors)
            cube_names.add(name)
        require(cube.get("bone") in bone_names, f"{label}.bone references a missing bone", errors)
        valid_vector(cube.get("center"), 3, f"{label}.center", errors)
        valid_vector(cube.get("size"), 3, f"{label}.size", errors, positive=True)
        valid_vector(cube.get("rotation"), 3, f"{label}.rotation", errors)
        valid_vector(cube.get("origin"), 3, f"{label}.origin", errors)
        require(isinstance(cube.get("role"), str) and bool(cube["role"]), f"{label}.role is required", errors)
        require(cube.get("material") in material_names, f"{label}.material references a missing material", errors)
        overrides = cube.get("faces", {})
        if not isinstance(overrides, dict):
            errors.append(f"{label}.faces must be an object")
        else:
            for face, override in overrides.items():
                require(face in FACES, f"{label}.faces contains invalid face {face}", errors)
                if not isinstance(override, dict):
                    errors.append(f"{label}.faces.{face} must be an object")
                    continue
                require(override.get("material", cube.get("material")) in material_names, f"{label}.faces.{face}.material is missing", errors)
                for flip in ("flip_x", "flip_y"):
                    require(flip not in override or isinstance(override[flip], bool), f"{label}.faces.{face}.{flip} must be boolean", errors)
                source_texture = override.get("source_texture")
                if source_texture is not None:
                    if not isinstance(source_texture, dict):
                        errors.append(
                            f"{label}.faces.{face}.source_texture must be an object"
                        )
                    else:
                        data_uri = source_texture.get("data_uri")
                        require(
                            isinstance(data_uri, str)
                            and data_uri.startswith("data:image/png;base64,"),
                            f"{label}.faces.{face}.source_texture.data_uri must be an embedded PNG",
                            errors,
                        )
                        valid_vector(
                            source_texture.get("repeat"),
                            2,
                            f"{label}.faces.{face}.source_texture.repeat",
                            errors,
                            positive=True,
                        )
                        valid_vector(
                            source_texture.get("offset"),
                            2,
                            f"{label}.faces.{face}.source_texture.offset",
                            errors,
                        )
                        valid_vector(
                            source_texture.get("center"),
                            2,
                            f"{label}.faces.{face}.source_texture.center",
                            errors,
                        )
                        require(
                            finite_number(source_texture.get("rotation")),
                            f"{label}.faces.{face}.source_texture.rotation must be finite",
                            errors,
                        )
                        wrap = source_texture.get("wrap")
                        require(
                            isinstance(wrap, list)
                            and len(wrap) == 2
                            and all(
                                value in {1000, 1001, 1002}
                                for value in wrap
                            ),
                            f"{label}.faces.{face}.source_texture.wrap is invalid",
                            errors,
                        )
                        require(
                            isinstance(source_texture.get("flip_y"), bool),
                            f"{label}.faces.{face}.source_texture.flip_y must be boolean",
                            errors,
                        )

    landmarks = spec.get("landmarks")
    if not isinstance(landmarks, list):
        errors.append("landmarks must be an array")
        landmarks = []
    landmark_names: set[str] = set()
    for index, landmark in enumerate(landmarks):
        label = f"landmarks[{index}]"
        if not isinstance(landmark, dict):
            errors.append(f"{label} must be an object")
            continue
        name = landmark.get("name")
        require(isinstance(name, str) and bool(ID_RE.fullmatch(name)), f"{label}.name is invalid", errors)
        if isinstance(name, str):
            require(name not in landmark_names, f"duplicate landmark name: {name}", errors)
            landmark_names.add(name)
        require(landmark.get("cube") in cube_names, f"{label}.cube references a missing cube", errors)
        require(landmark.get("face") in FACES, f"{label}.face is invalid", errors)
        if valid_vector(landmark.get("center_uv"), 2, f"{label}.center_uv", errors):
            require(all(0 <= float(item) <= 1 for item in landmark["center_uv"]), f"{label}.center_uv must be within 0..1", errors)
        if valid_vector(landmark.get("size"), 2, f"{label}.size", errors, positive=True):
            require(all(float(item).is_integer() for item in landmark["size"]), f"{label}.size values must be integers", errors)
        for color_key in ("color", "center_color"):
            color = landmark.get(color_key)
            require(isinstance(color, str) and bool(HEX_RE.fullmatch(color)), f"{label}.{color_key} must be #RRGGBB", errors)

    collision = spec.get("collision")
    if not isinstance(collision, dict):
        errors.append("collision must be an object")
    else:
        for key in ("width", "height", "eye_height"):
            value = collision.get(key)
            require(finite_number(value) and float(value) > 0, f"collision.{key} must be positive", errors)
        if finite_number(collision.get("height")) and finite_number(collision.get("eye_height")):
            require(float(collision["eye_height"]) <= float(collision["height"]), "collision.eye_height cannot exceed height", errors)

    if strict and target_min is not None and target_max is not None:
        require(target_min <= len(cubes) <= target_max, f"strict: cuboid count {len(cubes)} is outside target {target_min}..{target_max}", errors)
    return errors


def validated_spec(path: Path, *, strict: bool) -> dict[str, Any]:
    spec = read_json(path)
    errors = validate_spec(spec, strict=strict)
    if strict and not errors:
        reference_path = resolve_reference_path(path, spec)
        if not reference_path.is_file():
            errors.append(f"strict: reference image not found: {reference_path}")
        else:
            probe = image_probe(reference_path)
            reference = spec["reference"]
            if probe["sha256"] != reference["sha256"]:
                errors.append("strict: reference image SHA-256 does not match the specification")
            if [probe["width"], probe["height"]] != [reference["width"], reference["height"]]:
                errors.append("strict: reference image dimensions do not match the specification")
    if errors:
        raise ModelSpecError("\n".join(f"- {error}" for error in errors))
    return spec


def resolve_reference_path(spec_path: Path, spec: dict[str, Any]) -> Path:
    reference_path = Path(spec["reference"]["image"])
    if reference_path.is_absolute():
        return reference_path
    return (spec_path.parent / reference_path).resolve()


def image_probe(image_path: Path) -> dict[str, Any]:
    try:
        with Image.open(image_path) as source:
            image = source.convert("RGBA")
            width, height = image.size
            has_alpha = image.getextrema()[3][0] < 255
            thumbnail = image.convert("RGB")
            thumbnail.thumbnail((128, 128), Image.Resampling.LANCZOS)
            palette = thumbnail.quantize(
                colors=8,
                method=Image.Quantize.MAXCOVERAGE,
                dither=Image.Dither.NONE,
            ).convert("RGB")
            palette_data = (
                palette.get_flattened_data()
                if hasattr(palette, "get_flattened_data")
                else palette.getdata()
            )
            common = Counter(palette_data).most_common(8)
    except (FileNotFoundError, OSError) as exc:
        raise ModelSpecError(f"cannot read image {image_path}: {exc}") from exc
    return {
        "path": str(image_path.resolve()),
        "sha256": sha256_file(image_path),
        "width": width,
        "height": height,
        "mode": image.mode,
        "has_alpha": has_alpha,
        "aspect_ratio": round(width / height, 6),
        "dominant_colors": [
            {"hex": "#{:02x}{:02x}{:02x}".format(*rgb), "pixels": count}
            for rgb, count in common
        ],
    }


def starter_spec(image_path: Path, output_path: Path, model_id: str, description: str, complexity: str) -> dict[str, Any]:
    probe = image_probe(image_path)
    dominant = [item["hex"] for item in probe["dominant_colors"]]
    base = dominant[0] if dominant else "#a06b45"
    shade = dominant[1] if len(dominant) > 1 else "#60402a"
    highlight = dominant[2] if len(dominant) > 2 else "#d6a274"
    target = {"simple": [6, 15], "moderate": [15, 35], "complex": [25, 60]}[complexity]
    try:
        reference_image = Path(
            os.path.relpath(image_path.resolve(), output_path.parent.resolve())
        ).as_posix()
    except ValueError:
        reference_image = image_path.resolve().as_posix()
    return {
        "schema_version": SCHEMA_VERSION,
        "id": model_id,
        "reference": {
            "image": reference_image,
            "sha256": probe["sha256"],
            "width": probe["width"],
            "height": probe["height"],
        },
        "subject": {
            "type": "mob",
            "description": description,
            "symmetry": "bilateral",
            "uncertainties": ["Agent must inspect hidden-side geometry"],
        },
        "quality_contract": {
            "complexity": complexity,
            "target_cuboids": target,
            "identity_features": [],
            "required_views": ["front", "back", "left", "right", "isometric"],
            "review_targets": ["silhouette", "face", "joints", "texture"],
        },
        "texture": {
            "density": 2,
            "palette_size": 24,
            "gutter": 2,
            "atlas_size": 128,
        },
        "materials": {
            "primary": {
                "base": base,
                "shade": shade,
                "highlight": highlight,
                "pattern": "dither",
                "pattern_scale": 3,
            }
        },
        "bones": [
            {"name": "root", "parent": None, "pivot": [0, 0, 0]},
            {"name": "body", "parent": "root", "pivot": [0, 7, 0]},
            {"name": "head", "parent": "body", "pivot": [0, 10, 3]},
        ],
        "cubes": [
            {
                "name": "body",
                "bone": "body",
                "center": [0, 7, 0],
                "size": [6, 6, 10],
                "rotation": [0, 0, 0],
                "origin": [0, 7, 0],
                "role": "body",
                "material": "primary",
                "faces": {},
            },
            {
                "name": "head",
                "bone": "head",
                "center": [0, 11, 4],
                "size": [6, 6, 6],
                "rotation": [0, 0, 0],
                "origin": [0, 10, 3],
                "role": "head",
                "material": "primary",
                "faces": {},
            },
            {
                "name": "snout",
                "bone": "head",
                "center": [0, 10, 8],
                "size": [3, 2.5, 3],
                "rotation": [0, 0, 0],
                "origin": [0, 10, 3],
                "role": "snout",
                "material": "primary",
                "faces": {},
            },
        ],
        "landmarks": [],
        "collision": {"width": 0.8, "height": 1.2, "eye_height": 1.0},
    }


def safe_id(value: str, fallback: str) -> str:
    result = re.sub(r"[^a-z0-9_-]+", "_", value.strip().lower()).strip("_-")
    if not result or not result[0].isalnum():
        result = fallback
    return result[:64]


def adjusted_hex(color: str, factor: float) -> str:
    red, green, blue = hex_rgb(color)
    channels = [max(0, min(255, round(channel * factor))) for channel in (red, green, blue)]
    return "#{:02x}{:02x}{:02x}".format(*channels)


def three_matrix_components(
    matrix: Any,
    label: str,
) -> tuple[list[float], list[float], list[float]]:
    if not (
        isinstance(matrix, list)
        and len(matrix) == 16
        and all(finite_number(value) for value in matrix)
    ):
        raise ModelSpecError(f"{label}.matrix must contain 16 finite numbers")
    values = [float(value) for value in matrix]
    scales = [
        math.sqrt(sum(values[index + offset] ** 2 for offset in range(3)))
        for index in (0, 4, 8)
    ]
    if any(scale <= 1e-8 for scale in scales):
        raise ModelSpecError(f"{label} uses a zero matrix scale")

    m11, m12, m13 = (
        values[0] / scales[0],
        values[4] / scales[1],
        values[8] / scales[2],
    )
    m21, m22, m23 = (
        values[1] / scales[0],
        values[5] / scales[1],
        values[9] / scales[2],
    )
    m31, m32, m33 = (
        values[2] / scales[0],
        values[6] / scales[1],
        values[10] / scales[2],
    )
    y = math.asin(-max(-1.0, min(1.0, m31)))
    if abs(m31) < 0.9999999:
        x = math.atan2(m32, m33)
        z = math.atan2(m21, m11)
    else:
        x = 0.0
        z = math.atan2(-m12, m22)
    rotation = [math.degrees(value) for value in (x, y, z)]
    translation = [values[12], values[13], values[14]]
    return translation, rotation, scales


def make_material_name(name: str, index: int, used: set[str]) -> str:
    candidate = safe_id(name, f"material_{index + 1}")
    base = candidate
    suffix = 2
    while candidate in used:
        candidate = f"{base[:60]}_{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def import_threejs_scene(
    scene_path: Path,
    reference_path: Path,
    output_path: Path,
    model_id: str,
    description: str,
) -> dict[str, Any]:
    """Convert a constrained Object3D.toJSON scene into a native model spec."""
    scene = read_json(scene_path)
    if not isinstance(scene, dict) or not isinstance(scene.get("object"), dict):
        raise ModelSpecError("Three.js scene must be Object3D.toJSON output")
    geometries = {
        item["uuid"]: item
        for item in scene.get("geometries", [])
        if isinstance(item, dict) and isinstance(item.get("uuid"), str)
    }
    source_materials = [
        item
        for item in scene.get("materials", [])
        if isinstance(item, dict) and isinstance(item.get("uuid"), str)
    ]
    source_textures = {
        item["uuid"]: item
        for item in scene.get("textures", [])
        if isinstance(item, dict) and isinstance(item.get("uuid"), str)
    }
    source_images = {
        item["uuid"]: item
        for item in scene.get("images", [])
        if isinstance(item, dict) and isinstance(item.get("uuid"), str)
    }
    material_names: dict[str, str] = {}
    materials: dict[str, Any] = {}
    used_material_names: set[str] = set()
    for index, material in enumerate(source_materials):
        if material.get("type") not in {
            "MeshBasicMaterial",
            "MeshLambertMaterial",
            "MeshPhongMaterial",
            "MeshStandardMaterial",
            "MeshPhysicalMaterial",
        }:
            raise ModelSpecError(
                f"unsupported Three.js material type: {material.get('type')}"
            )
        sculpt_material = (
            material.get("userData", {}).get("sculptMaterial", {})
            if isinstance(material.get("userData"), dict)
            else {}
        )
        sculpt_color = (
            sculpt_material.get("baseColor", sculpt_material.get("color"))
            if isinstance(sculpt_material, dict)
            else None
        )
        if isinstance(sculpt_color, str) and re.fullmatch(
            r"#[0-9A-Fa-f]{6}", sculpt_color
        ):
            base = sculpt_color.lower()
        else:
            color_number = material.get("color", 0xA06B45)
            if not isinstance(color_number, int) or isinstance(color_number, bool):
                raise ModelSpecError("Three.js material color must be an integer")
            base = f"#{color_number & 0xFFFFFF:06x}"
        name = make_material_name(material.get("name", ""), index, used_material_names)
        material_names[material["uuid"]] = name
        imported_material = {
            "base": base,
            "shade": adjusted_hex(base, 0.62),
            "highlight": adjusted_hex(base, 1.28),
            "pattern": "dither",
            "pattern_scale": 4,
        }
        if isinstance(sculpt_material, dict):
            source_material_id = sculpt_material.get("id")
            if isinstance(source_material_id, str) and source_material_id:
                imported_material["source_material_id"] = source_material_id
                if "strip" in source_material_id.lower():
                    imported_material["pattern"] = "stripes"
            color_variation = sculpt_material.get("colorVariation")
            source_palette = (
                color_variation.get("palette")
                if isinstance(color_variation, dict)
                else None
            )
            if isinstance(source_palette, list):
                reference_palette = [
                    color.lower()
                    for color in source_palette
                    if isinstance(color, str)
                    and re.fullmatch(r"#[0-9A-Fa-f]{6}", color)
                ]
                if reference_palette:
                    imported_material["reference_palette"] = reference_palette
        texture_uuid = material.get("map")
        texture = source_textures.get(texture_uuid)
        if texture is not None:
            image = source_images.get(texture.get("image"))
            data_uri = image.get("url") if isinstance(image, dict) else None
            if not isinstance(data_uri, str) or not data_uri.startswith(
                "data:image/png;base64,"
            ):
                raise ModelSpecError(
                    f"Three.js material {name} map must reference an embedded PNG"
                )
            imported_material["source_texture"] = {
                "data_uri": data_uri,
                "repeat": texture.get("repeat", [1, 1]),
                "offset": texture.get("offset", [0, 0]),
                "center": texture.get("center", [0, 0]),
                "rotation": texture.get("rotation", 0),
                "wrap": texture.get("wrap", [1001, 1001]),
                "flip_y": texture.get("flipY", True),
            }
        materials[name] = imported_material
    if not materials:
        raise ModelSpecError("Three.js scene contains no supported materials")

    cubes: list[dict[str, Any]] = []
    bone_records: dict[str, dict[str, Any]] = {}
    used_cube_names: set[str] = set()

    def unique_cube_name(value: str, fallback: str) -> str:
        candidate = safe_id(value, fallback)
        base = candidate
        suffix = 2
        while candidate in used_cube_names:
            candidate = f"{base[:60]}_{suffix}"
            suffix += 1
        used_cube_names.add(candidate)
        return candidate

    def visit(node: dict[str, Any], parent_pivot: dict[str, Any] | None = None) -> None:
        node_type = node.get("type")
        user_data = node.get("userData")
        blockbench = (
            user_data.get("img2blockbench", {})
            if isinstance(user_data, dict)
            else {}
        )
        if not isinstance(blockbench, dict):
            blockbench = {}
        if blockbench.get("exclude") is True:
            return

        pivot = parent_pivot
        if node_type in {"Group", "Object3D", "Bone"} and node is not scene["object"]:
            if parent_pivot is not None:
                raise ModelSpecError(
                    "nested Three.js pivot transforms are unsupported; flatten pivots under the root"
                )
            origin, rotation, pivot_scale = three_matrix_components(
                node.get("matrix"), f"object {node.get('name', '<unnamed>')}"
            )
            bone_name = safe_id(
                str(blockbench.get("bone") or node.get("name", "")).removesuffix(
                    "_pivot"
                ),
                f"bone_{len(bone_records) + 1}",
            )
            parent_name = safe_id(
                str(blockbench.get("parent", "root")), "root"
            )
            if parent_name == bone_name:
                parent_name = "root"
            pivot = {
                "origin": origin,
                "rotation": rotation,
                "scale": pivot_scale,
                "bone": bone_name,
                "parent": parent_name,
                "role": str(blockbench.get("role") or node.get("name") or bone_name),
            }
            bone_records.setdefault(
                bone_name,
                {"name": bone_name, "parent": parent_name, "pivot": origin},
            )

        if node_type == "Mesh":
            if pivot is None:
                raise ModelSpecError("every Three.js Mesh must be inside a pivot Group")
            geometry = geometries.get(node.get("geometry"))
            if not geometry or geometry.get("type") != "BoxGeometry":
                raise ModelSpecError(
                    f"mesh {node.get('name', '<unnamed>')} must use BoxGeometry"
                )
            geometry_size = [
                float(geometry.get("width", 1)),
                float(geometry.get("height", 1)),
                float(geometry.get("depth", 1)),
            ]
            if any(value <= 0 for value in geometry_size):
                raise ModelSpecError("BoxGeometry dimensions must be positive")
            local, local_rotation, local_scale = three_matrix_components(
                node.get("matrix"), f"mesh {node.get('name', '<unnamed>')}"
            )
            if any(abs(value) > 1e-5 for value in local_rotation):
                raise ModelSpecError(
                    f"mesh {node.get('name', '<unnamed>')} rotates outside its pivot"
                )
            size = [
                geometry_size[axis] * pivot["scale"][axis] * local_scale[axis]
                for axis in range(3)
            ]
            material_ids = node.get("material")
            if isinstance(material_ids, str):
                material_ids = [material_ids] * 6
            if not isinstance(material_ids, list) or not material_ids:
                raise ModelSpecError("Three.js Mesh must reference material UUIDs")
            if len(material_ids) == 1:
                material_ids *= 6
            if len(material_ids) != 6:
                raise ModelSpecError(
                    "BoxGeometry material arrays must follow east, west, up, down, south, north"
                )
            try:
                face_materials = [material_names[uuid_value] for uuid_value in material_ids]
            except KeyError as exc:
                raise ModelSpecError(
                    f"mesh references missing material UUID: {exc.args[0]}"
                ) from exc
            primary = Counter(face_materials).most_common(1)[0][0]
            # Three BoxGeometry order: east, west, up, down, south, north.
            faces = {
                face: {"material": material}
                for face, material in zip(
                    ("east", "west", "up", "down", "south", "north"),
                    face_materials,
                )
                if material != primary
            }
            cube_name = unique_cube_name(
                str(node.get("name", "")), f"cube_{len(cubes) + 1}"
            )
            cube_metadata = blockbench
            cubes.append(
                {
                    "name": cube_name,
                    "bone": pivot["bone"],
                    "center": [
                        normalize_number(pivot["origin"][axis] + local[axis])
                        for axis in range(3)
                    ],
                    "size": [normalize_number(value) for value in size],
                    "rotation": [
                        normalize_number(value) for value in pivot["rotation"]
                    ],
                    "origin": [
                        normalize_number(value) for value in pivot["origin"]
                    ],
                    "role": str(cube_metadata.get("role") or pivot["role"]),
                    "material": primary,
                    "faces": faces,
                }
            )

        children = node.get("children", [])
        if not isinstance(children, list):
            raise ModelSpecError("Three.js object children must be an array")
        for child in children:
            if not isinstance(child, dict):
                raise ModelSpecError("Three.js child must be an object")
            visit(child, pivot)

    root_object = scene["object"]
    for child in root_object.get("children", []):
        visit(child)
    if not cubes:
        raise ModelSpecError("Three.js scene contains no importable BoxGeometry meshes")
    if len(cubes) > 96:
        raise ModelSpecError("Three.js scene exceeds the 96-cuboid limit")

    existing_bones = set(bone_records)
    for bone in bone_records.values():
        if bone["parent"] not in existing_bones and bone["parent"] != "root":
            bone["parent"] = "root"
    bones = [{"name": "root", "parent": None, "pivot": [0, 0, 0]}]
    bones.extend(bone_records.values())

    spec = starter_spec(
        reference_path, output_path, model_id, description, "moderate"
    )
    spec["subject"]["uncertainties"] = [
        "Hidden surfaces are inferred from the single reference image",
        "Procedural Three.js geometry is limited to Minecraft-compatible boxes",
    ]
    spec["quality_contract"]["identity_features"] = [description]
    spec["quality_contract"]["target_cuboids"] = [
        max(1, len(cubes) - 6),
        min(96, len(cubes) + 8),
    ]
    spec["materials"] = materials
    spec["bones"] = bones
    spec["cubes"] = cubes
    spec["generation"] = {
        "lane": "threejs",
        "intermediate": "Object3D.toJSON",
    }
    root_user_data = root_object.get("userData", {})
    root_metadata = (
        root_user_data.get("img2blockbench", {})
        if isinstance(root_user_data, dict)
        else {}
    )
    landmarks = root_metadata.get("landmarks", [])
    spec["landmarks"] = landmarks if isinstance(landmarks, list) else []

    lower = [
        min(float(cube["center"][axis]) - float(cube["size"][axis]) / 2 for cube in cubes)
        for axis in range(3)
    ]
    upper = [
        max(float(cube["center"][axis]) + float(cube["size"][axis]) / 2 for cube in cubes)
        for axis in range(3)
    ]
    width = (upper[0] - lower[0]) / 16
    height = (upper[1] - min(0.0, lower[1])) / 16
    spec["collision"] = {
        "width": round(max(0.25, width), 3),
        "height": round(max(0.25, height), 3),
        "eye_height": round(max(0.2, height * 0.78), 3),
    }
    errors = validate_spec(spec, strict=True)
    if errors:
        raise ModelSpecError(
            "imported Three.js scene is invalid:\n"
            + "\n".join(f"- {error}" for error in errors)
        )
    return spec


def hex_rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


def snap(value: float, density: int) -> float:
    return round(float(value) * density) / density


def face_dimensions(cube: dict[str, Any], face: str, density: int) -> tuple[int, int]:
    _, u_axis, v_axis, _ = FACE_AXES[face]
    size = [snap(item, density) for item in cube["size"]]
    return (
        max(1, math.ceil(float(size[u_axis]) * density)),
        max(1, math.ceil(float(size[v_axis]) * density)),
    )


def pack_faces(spec: dict[str, Any]) -> tuple[int, dict[tuple[str, str], tuple[int, int, int, int]]]:
    texture = spec["texture"]
    density = texture["density"]
    gutter = texture["gutter"]
    entries: list[tuple[str, str, int, int]] = []
    for cube in spec["cubes"]:
        for face in FACES:
            width, height = face_dimensions(cube, face, density)
            entries.append((cube["name"], face, width, height))

    size = texture["atlas_size"]
    while size <= 512:
        placements: dict[tuple[str, str], tuple[int, int, int, int]] = {}
        x = gutter
        y = gutter
        row_height = 0
        fits = True
        for cube_name, face, width, height in entries:
            outer_width = width + gutter * 2
            outer_height = height + gutter * 2
            if x + outer_width > size:
                x = gutter
                y += row_height
                row_height = 0
            if y + outer_height > size:
                fits = False
                break
            placements[(cube_name, face)] = (x + gutter, y + gutter, width, height)
            x += outer_width
            row_height = max(row_height, outer_height)
        if fits:
            return size, placements
        size *= 2
    raise ModelSpecError("texture faces do not fit in a 512x512 atlas")


def material_for_face(spec: dict[str, Any], cube: dict[str, Any], face: str) -> dict[str, Any]:
    override = cube.get("faces", {}).get(face, {})
    return spec["materials"][override.get("material", cube["material"])]


def decode_source_texture(material: dict[str, Any]) -> Image.Image | None:
    source_texture = material.get("source_texture")
    if not isinstance(source_texture, dict):
        return None
    data_uri = source_texture.get("data_uri")
    prefix = "data:image/png;base64,"
    if not isinstance(data_uri, str) or not data_uri.startswith(prefix):
        raise ModelSpecError("source texture must be an embedded PNG")
    try:
        raw = base64.b64decode(data_uri[len(prefix) :], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            return image.convert("RGBA")
    except (ValueError, OSError) as exc:
        raise ModelSpecError(f"source texture is not a valid PNG: {exc}") from exc


def wrap_texture_coordinate(value: float, mode: int) -> float:
    if mode == 1000:
        return value - math.floor(value)
    if mode == 1002:
        whole = math.floor(value)
        fraction = value - whole
        return fraction if whole % 2 == 0 else 1.0 - fraction
    return min(1.0, max(0.0, value))


def source_texture_pixel(
    material: dict[str, Any],
    image: Image.Image,
    x: int,
    y: int,
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    source = material["source_texture"]
    repeat_x, repeat_y = (float(value) for value in source["repeat"])
    offset_x, offset_y = (float(value) for value in source["offset"])
    center_x, center_y = (float(value) for value in source["center"])
    rotation = float(source["rotation"])

    u = (x + 0.5) / width
    v = 1.0 - (y + 0.5) / height
    centered_u = u - center_x
    centered_v = v - center_y
    cosine = math.cos(rotation)
    sine = math.sin(rotation)
    transformed_u = (
        repeat_x * (cosine * centered_u + sine * centered_v)
        + center_x
        + offset_x
    )
    transformed_v = (
        repeat_y * (-sine * centered_u + cosine * centered_v)
        + center_y
        + offset_y
    )
    transformed_u = wrap_texture_coordinate(transformed_u, source["wrap"][0])
    transformed_v = wrap_texture_coordinate(transformed_v, source["wrap"][1])

    source_x = min(image.width - 1, int(transformed_u * image.width))
    image_v = 1.0 - transformed_v if source["flip_y"] else transformed_v
    source_y = min(image.height - 1, int(image_v * image.height))
    return image.getpixel((source_x, source_y))


def pattern_pixel(
    material: dict[str, Any],
    x: int,
    y: int,
    width: int,
    height: int,
    seed: int,
) -> tuple[int, int, int, int]:
    base = hex_rgb(material["base"])
    shade = hex_rgb(material["shade"])
    highlight = hex_rgb(material["highlight"])
    scale = material["pattern_scale"]
    pattern = material["pattern"]
    value = ((x * 73_856_093) ^ (y * 19_349_663) ^ seed) & 0xFF
    if pattern == "solid":
        color = base
    elif pattern == "dither":
        threshold = max(3, 14 - scale)
        color = shade if value < threshold else highlight if value > 255 - threshold else base
    elif pattern == "stripes":
        color = shade if ((x + seed) // scale) % 4 == 0 else base
    elif pattern == "spots":
        color = shade if ((x // scale) * 11 + (y // scale) * 7 + seed) % 13 < 2 else base
    else:
        ratio = y / max(1, height - 1)
        target = highlight if ratio < 0.35 else shade if ratio > 0.72 else base
        color = tuple(round(base[index] * 0.65 + target[index] * 0.35) for index in range(3))
    return (*color, 255)


def landmark_rect(
    landmark: dict[str, Any],
    placement: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    px, py, width, height = placement
    mark_width = max(1, int(landmark["size"][0]))
    mark_height = max(1, int(landmark["size"][1]))
    center_x = px + round(float(landmark["center_uv"][0]) * max(0, width - 1))
    center_y = py + round(float(landmark["center_uv"][1]) * max(0, height - 1))
    left = max(px, center_x - mark_width // 2)
    top = max(py, center_y - mark_height // 2)
    right = min(px + width, left + mark_width)
    bottom = min(py + height, top + mark_height)
    return left, top, right, bottom


def apply_landmarks(
    atlas: Image.Image,
    spec: dict[str, Any],
    placements: dict[tuple[str, str], tuple[int, int, int, int]],
) -> None:
    pixels = atlas.load()
    for landmark in spec["landmarks"]:
        rect = landmark_rect(landmark, placements[(landmark["cube"], landmark["face"])])
        color = (*hex_rgb(landmark["color"]), 255)
        center_color = (*hex_rgb(landmark["center_color"]), 255)
        for y in range(rect[1], rect[3]):
            for x in range(rect[0], rect[2]):
                pixels[x, y] = color
        center_x = (rect[0] + rect[2] - 1) // 2
        center_y = (rect[1] + rect[3] - 1) // 2
        pixels[center_x, center_y] = center_color


def build_texture(
    spec: dict[str, Any],
) -> tuple[Image.Image, dict[tuple[str, str], tuple[int, int, int, int]]]:
    atlas_size, placements = pack_faces(spec)
    atlas = Image.new("RGBA", (atlas_size, atlas_size), (0, 0, 0, 0))
    pixels = atlas.load()
    cube_by_name = {cube["name"]: cube for cube in spec["cubes"]}
    source_images = {
        name: decode_source_texture(material)
        for name, material in spec["materials"].items()
    }
    used_source_texture = False
    for (cube_name, face), (left, top, width, height) in placements.items():
        cube = cube_by_name[cube_name]
        material = material_for_face(spec, cube, face)
        face_override = cube.get("faces", {}).get(face, {})
        face_source = (
            face_override.get("source_texture")
            if isinstance(face_override, dict)
            else None
        )
        if isinstance(face_source, dict):
            material = {**material, "source_texture": face_source}
            source_image = decode_source_texture(material)
        else:
            source_image = source_images[
                face_override.get("material", cube["material"])
            ]
        seed = int(hashlib.sha256(f"{cube_name}/{face}/{cube['material']}".encode()).hexdigest()[:8], 16)
        for y in range(height):
            for x in range(width):
                if source_image is not None:
                    pixels[left + x, top + y] = source_texture_pixel(
                        material, source_image, x, y, width, height
                    )
                    used_source_texture = True
                else:
                    pixels[left + x, top + y] = pattern_pixel(
                        material, x, y, width, height, seed
                    )

    apply_landmarks(atlas, spec, placements)

    if used_source_texture and not spec["texture"].get("quantize_source", False):
        quantized = atlas
    else:
        alpha = atlas.getchannel("A")
        quantized = atlas.convert("RGB").quantize(
            colors=spec["texture"]["palette_size"],
            method=Image.Quantize.MAXCOVERAGE,
            dither=Image.Dither.NONE,
        ).convert("RGBA")
        quantized.putalpha(alpha)
        apply_landmarks(quantized, spec, placements)

    pixels = quantized.load()
    gutter = spec["texture"]["gutter"]
    for left, top, width, height in placements.values():
        for y in range(top - gutter, top + height + gutter):
            for x in range(left - gutter, left + width + gutter):
                source_x = min(max(x, left), left + width - 1)
                source_y = min(max(y, top), top + height - 1)
                pixels[x, y] = pixels[source_x, source_y]
    return quantized, placements


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def face_uv(
    cube: dict[str, Any],
    face: str,
    placement: tuple[int, int, int, int],
) -> list[int]:
    left, top, width, height = placement
    override = cube.get("faces", {}).get(face, {})
    flip_x = (face in {"east", "north"}) ^ bool(override.get("flip_x", False))
    flip_y = bool(override.get("flip_y", False))
    x1, x2 = (left + width, left) if flip_x else (left, left + width)
    y1, y2 = (top + height, top) if flip_y else (top, top + height)
    return [x1, y1, x2, y2]


def normalize_number(value: float) -> int | float:
    rounded = round(float(value), 6)
    return int(rounded) if rounded.is_integer() else rounded


def make_bbmodel(
    spec: dict[str, Any],
    texture_bytes: bytes,
    atlas_size: int,
    placements: dict[tuple[str, str], tuple[int, int, int, int]],
) -> dict[str, Any]:
    model_id = spec["id"]
    element_by_name: dict[str, dict[str, Any]] = {}
    for cube in spec["cubes"]:
        center = [snap(item, spec["texture"]["density"]) for item in cube["center"]]
        size = [snap(item, spec["texture"]["density"]) for item in cube["size"]]
        origin = [normalize_number(item) for item in cube["origin"]]
        element_uuid = stable_uuid(model_id, "cube", cube["name"])
        element_by_name[cube["name"]] = {
            "name": cube["name"],
            "box_uv": False,
            "rescale": False,
            "locked": False,
            "render_order": "default",
            "allow_mirror_modeling": True,
            "from": [normalize_number(center[index] - size[index] / 2) for index in range(3)],
            "to": [normalize_number(center[index] + size[index] / 2) for index in range(3)],
            "autouv": 0,
            "color": 0,
            "origin": origin,
            "rotation": [normalize_number(item) for item in cube["rotation"]],
            "faces": {
                face: {
                    "uv": face_uv(cube, face, placements[(cube["name"], face)]),
                    "texture": 0,
                }
                for face in FACES
            },
            "type": "cube",
            "uuid": element_uuid,
        }

    bones = spec["bones"]
    bone_by_name = {bone["name"]: bone for bone in bones}
    cube_names_by_bone: dict[str, list[str]] = {name: [] for name in bone_by_name}
    for cube in spec["cubes"]:
        cube_names_by_bone[cube["bone"]].append(cube["name"])

    def group_for(name: str) -> dict[str, Any]:
        bone = bone_by_name[name]
        child_groups = [
            group_for(child["name"])
            for child in bones
            if child.get("parent") == name
        ]
        element_uuids = [
            element_by_name[cube_name]["uuid"]
            for cube_name in cube_names_by_bone[name]
        ]
        return {
            "name": name,
            "origin": [normalize_number(item) for item in bone["pivot"]],
            "color": 0,
            "uuid": stable_uuid(model_id, "bone", name),
            "export": True,
            "isOpen": True,
            "locked": False,
            "visibility": True,
            "autouv": 0,
            "children": element_uuids + child_groups,
        }

    roots = [bone["name"] for bone in bones if bone.get("parent") is None]
    data_uri = "data:image/png;base64," + base64.b64encode(texture_bytes).decode("ascii")
    return {
        "meta": {
            "format_version": "5.0",
            "creation_time": 0,
            "model_format": "free",
            "box_uv": False,
        },
        "name": model_id,
        "model_identifier": "",
        "visible_box": [1, 1, 0],
        "variable_placeholders": "",
        "variable_placeholder_buttons": [],
        "resolution": {"width": atlas_size, "height": atlas_size},
        "elements": [element_by_name[cube["name"]] for cube in spec["cubes"]],
        "outliner": [group_for(name) for name in roots],
        "textures": [
            {
                "path": f"{model_id}.png",
                "name": f"{model_id}.png",
                "folder": "",
                "namespace": "",
                "id": "0",
                "particle": False,
                "render_mode": "default",
                "render_sides": "auto",
                "frame_time": 1,
                "frame_order_type": "loop",
                "frame_order": "",
                "frame_interpolate": False,
                "visible": True,
                "internal": True,
                "saved": True,
                "uuid": stable_uuid(model_id, "texture"),
                "source": data_uri,
            }
        ],
    }


def make_bedrock_geometry(
    spec: dict[str, Any],
    placements: dict[tuple[str, str], tuple[int, int, int, int]],
    atlas_size: int,
) -> dict[str, Any]:
    cubes_by_bone: dict[str, list[dict[str, Any]]] = {
        bone["name"]: [] for bone in spec["bones"]
    }
    for cube in spec["cubes"]:
        center = [snap(item, spec["texture"]["density"]) for item in cube["center"]]
        size = [snap(item, spec["texture"]["density"]) for item in cube["size"]]
        faces = {}
        for face in FACES:
            left, top, width, height = placements[(cube["name"], face)]
            faces[face] = {"uv": [left, top], "uv_size": [width, height]}
        cubes_by_bone[cube["bone"]].append(
            {
                "origin": [
                    normalize_number(center[0] - size[0] / 2),
                    normalize_number(center[1] - size[1] / 2),
                    normalize_number(center[2] - size[2] / 2),
                ],
                "size": [normalize_number(item) for item in size],
                "pivot": [normalize_number(item) for item in cube["origin"]],
                "rotation": [normalize_number(-item) for item in cube["rotation"]],
                "uv": faces,
            }
        )
    bones = []
    for bone in spec["bones"]:
        output = {
            "name": bone["name"],
            "pivot": [normalize_number(item) for item in bone["pivot"]],
        }
        if bone["parent"] is not None:
            output["parent"] = bone["parent"]
        if cubes_by_bone[bone["name"]]:
            output["cubes"] = cubes_by_bone[bone["name"]]
        bones.append(output)
    collision = spec["collision"]
    return {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": f"geometry.{spec['id']}",
                    "texture_width": atlas_size,
                    "texture_height": atlas_size,
                    "visible_bounds_width": normalize_number(collision["width"] * 16),
                    "visible_bounds_height": normalize_number(collision["height"] * 16),
                    "visible_bounds_offset": [0, normalize_number(collision["height"] * 8), 0],
                },
                "bones": bones,
            }
        ],
    }


def audit_bbmodel(data: Any) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(data, dict):
        return {"ok": False, "errors": ["bbmodel must be a JSON object"], "warnings": []}
    meta = data.get("meta")
    if not isinstance(meta, dict):
        errors.append("missing meta object")
    resolution = data.get("resolution")
    if not isinstance(resolution, dict):
        errors.append("missing resolution object")
        width = height = 0
    else:
        width = resolution.get("width", 0)
        height = resolution.get("height", 0)
        if not (isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0):
            errors.append("invalid texture resolution")
            width = height = 0

    elements = data.get("elements")
    if not isinstance(elements, list) or not elements:
        errors.append("elements must be a non-empty array")
        elements = []
    element_ids: set[str] = set()
    for index, element in enumerate(elements):
        if not isinstance(element, dict):
            errors.append(f"elements[{index}] must be an object")
            continue
        element_uuid = element.get("uuid")
        if not isinstance(element_uuid, str):
            errors.append(f"elements[{index}] has no UUID")
        elif element_uuid in element_ids:
            errors.append(f"duplicate UUID: {element_uuid}")
        else:
            element_ids.add(element_uuid)
        from_pos = element.get("from")
        to_pos = element.get("to")
        if not (
            isinstance(from_pos, list)
            and isinstance(to_pos, list)
            and len(from_pos) == len(to_pos) == 3
            and all(finite_number(item) for item in from_pos + to_pos)
            and all(float(to_pos[axis]) > float(from_pos[axis]) for axis in range(3))
        ):
            errors.append(f"elements[{index}] has invalid bounds")
        faces = element.get("faces")
        if not isinstance(faces, dict) or set(faces) != set(FACES):
            errors.append(f"elements[{index}] must contain six faces")
        else:
            for face, face_data in faces.items():
                uv = face_data.get("uv") if isinstance(face_data, dict) else None
                if not (
                    isinstance(uv, list)
                    and len(uv) == 4
                    and all(finite_number(item) for item in uv)
                    and all(0 <= float(uv[item]) <= width for item in (0, 2))
                    and all(0 <= float(uv[item]) <= height for item in (1, 3))
                ):
                    errors.append(f"elements[{index}].faces.{face} has invalid UV")

    textures = data.get("textures")
    embedded = []
    if isinstance(textures, list):
        embedded = [
            texture for texture in textures
            if isinstance(texture, dict)
            and isinstance(texture.get("source"), str)
            and texture["source"].startswith("data:image/png;base64,")
        ]
    if len(embedded) != 1:
        errors.append("expected exactly one embedded PNG texture")
    elif width and height:
        try:
            raw = base64.b64decode(embedded[0]["source"].split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(raw)) as texture:
                if texture.size != (width, height):
                    errors.append("embedded texture dimensions do not match resolution")
        except (ValueError, OSError) as exc:
            errors.append(f"embedded texture is invalid: {exc}")

    group_ids: set[str] = set()
    referenced_elements: set[str] = set()

    def visit_group(group: Any, path: str) -> None:
        if not isinstance(group, dict):
            errors.append(f"{path} must be a group object")
            return
        group_uuid = group.get("uuid")
        if not isinstance(group_uuid, str):
            errors.append(f"{path} has no UUID")
        elif group_uuid in group_ids or group_uuid in element_ids:
            errors.append(f"duplicate UUID: {group_uuid}")
        else:
            group_ids.add(group_uuid)
        children = group.get("children")
        if not isinstance(children, list):
            errors.append(f"{path}.children must be an array")
            return
        for index, child in enumerate(children):
            if isinstance(child, str):
                if child not in element_ids:
                    errors.append(f"{path}.children[{index}] references missing element")
                referenced_elements.add(child)
            else:
                visit_group(child, f"{path}.children[{index}]")

    outliner = data.get("outliner")
    if not isinstance(outliner, list) or not outliner:
        errors.append("outliner must contain at least one group")
    else:
        for index, group in enumerate(outliner):
            visit_group(group, f"outliner[{index}]")
    orphans = element_ids - referenced_elements
    if orphans:
        errors.append(f"{len(orphans)} element(s) are orphaned from the outliner")

    if len(elements) > 60:
        warnings.append("high cuboid count may be expensive in Minecraft")
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "cuboids": len(elements),
        "bones": len(group_ids),
        "texture_size": [width, height],
        "estimated_triangles": len(elements) * 12,
    }


def deterministic_zip(path: Path, files: list[Path], base_dir: Path) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file_path in sorted(files, key=lambda item: item.name):
            info = zipfile.ZipInfo(file_path.relative_to(base_dir).as_posix())
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file_path.read_bytes())


def typescript_identifier(value: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", value)
    identifier = "".join(word[:1].upper() + word[1:] for word in words)
    if not identifier:
        identifier = "Model"
    if identifier[0].isdigit():
        identifier = f"Model{identifier}"
    return identifier


def make_threejs_factory(spec: dict[str, Any]) -> str:
    """Emit a constrained Three.js preview from the same cuboid specification."""
    errors = validate_spec(spec, strict=True)
    if errors:
        raise ModelSpecError(
            "cannot export invalid specification:\n"
            + "\n".join(f"- {error}" for error in errors)
        )

    function_name = f"create{typescript_identifier(spec['id'])}Model"
    material_names = list(spec["materials"])
    material_indexes = {name: index for index, name in enumerate(material_names)}
    lines = [
        'import * as THREE from "three";',
        "",
        "/**",
        " * Generated by img2blockbench from its Minecraft cuboid scene spec.",
        " * Edit the JSON specification, not this generated file.",
        " */",
        f"export function {function_name}(): THREE.Group {{",
        "  const root = new THREE.Group();",
        f'  root.name = {json.dumps(spec["id"])};',
        "  const materials = [",
    ]
    for name in material_names:
        color = spec["materials"][name]["base"]
        lines.append(
            "    new THREE.MeshBasicMaterial({ "
            f"name: {json.dumps(name)}, color: {json.dumps(color)}, toneMapped: false "
            "}),"
        )
    lines.extend(["  ];", ""])

    for cube in spec["cubes"]:
        override_faces = cube.get("faces", {})
        face_materials = []
        for face in ("east", "west", "up", "down", "south", "north"):
            material_name = override_faces.get(face, {}).get(
                "material", cube["material"]
            )
            face_materials.append(f"materials[{material_indexes[material_name]}]")
        center = [float(value) for value in cube["center"]]
        size = [float(value) for value in cube["size"]]
        origin = [float(value) for value in cube["origin"]]
        rotation = [math.radians(float(value)) for value in cube["rotation"]]
        local = [center[index] - origin[index] for index in range(3)]
        safe_name = json.dumps(cube["name"])
        lines.extend(
            [
                "  {",
                "    const mesh = new THREE.Mesh(",
                f"      new THREE.BoxGeometry({size[0]:g}, {size[1]:g}, {size[2]:g}),",
                f"      [{', '.join(face_materials)}],",
                "    );",
                f"    mesh.name = {safe_name};",
                f"    mesh.position.set({local[0]:g}, {local[1]:g}, {local[2]:g});",
                "    const pivot = new THREE.Group();",
                f"    pivot.name = {json.dumps(cube['name'] + '_pivot')};",
                f"    pivot.position.set({origin[0]:g}, {origin[1]:g}, {origin[2]:g});",
                '    pivot.rotation.order = "ZYX";',
                f"    pivot.rotation.set({rotation[0]:.12g}, {rotation[1]:.12g}, {rotation[2]:.12g});",
                "    pivot.add(mesh);",
                "    root.add(pivot);",
                "  }",
                "",
            ]
        )

    lines.extend(
        [
            "  root.userData.img2blockbench = {",
            '    representation: "minecraft-cuboids",',
            f"    componentCount: {len(spec['cubes'])},",
            '    source: "agent-authored-image-reconstruction",',
            "  };",
            "  return root;",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def build_model(spec_path: Path, output_dir: Path) -> dict[str, Any]:
    spec = validated_spec(spec_path, strict=True)
    reference_input = resolve_reference_path(spec_path, spec)
    output_dir.mkdir(parents=True, exist_ok=True)
    model_id = spec["id"]

    texture, placements = build_texture(spec)
    texture_raw = png_bytes(texture)
    bbmodel = make_bbmodel(spec, texture_raw, texture.width, placements)
    audit = audit_bbmodel(bbmodel)
    if not audit["ok"]:
        raise ModelSpecError("generated bbmodel failed audit:\n" + "\n".join(f"- {error}" for error in audit["errors"]))

    spec_output = output_dir / f"{model_id}.model-spec.json"
    texture_output = output_dir / f"{model_id}.png"
    bbmodel_output = output_dir / f"{model_id}.bbmodel"
    geometry_output = output_dir / f"{model_id}.geo.json"
    audit_output = output_dir / f"{model_id}.audit.json"
    manifest_output = output_dir / f"{model_id}.manifest.json"
    bundle_output = output_dir / f"{model_id}.zip"
    reference_suffix = reference_input.suffix.lower() or ".img"
    reference_output = output_dir / f"{model_id}.reference{reference_suffix}"

    delivery_spec = json.loads(json.dumps(spec))
    delivery_spec["reference"]["image"] = reference_output.name
    write_json(spec_output, delivery_spec)
    reference_output.write_bytes(reference_input.read_bytes())
    texture_output.write_bytes(texture_raw)
    write_json(bbmodel_output, bbmodel)
    write_json(geometry_output, make_bedrock_geometry(spec, placements, texture.width))
    write_json(audit_output, audit)

    artifact_paths = [
        spec_output,
        texture_output,
        bbmodel_output,
        geometry_output,
        audit_output,
        reference_output,
    ]
    generation = spec.get("generation", {})
    manifest_lane = (
        generation.get("lane", "direct")
        if isinstance(generation, dict)
        else "direct"
    )
    manifest = {
        "schema_version": 1,
        "generator": {
            "name": "img2blockbench",
            "version": VERSION,
            "lane": manifest_lane,
        },
        "model_id": model_id,
        "reference": delivery_spec["reference"],
        "collision": spec["collision"],
        "artifacts": [
            {
                "path": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in artifact_paths
        ],
    }
    write_json(manifest_output, manifest)
    deterministic_zip(
        bundle_output,
        artifact_paths + [manifest_output],
        output_dir,
    )
    return {
        "ok": True,
        "model_id": model_id,
        "output": str(output_dir.resolve()),
        "bundle": str(bundle_output.resolve()),
        "audit": audit,
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="img2blockbench",
        description="Compile agent-authored image reconstructions into Minecraft models.",
    )
    root.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    commands = root.add_subparsers(dest="command", required=True)

    probe = commands.add_parser("probe", help="Inspect reference image metadata and palette")
    probe.add_argument("image", type=Path)
    probe.add_argument("--output", type=Path)

    new = commands.add_parser("new", help="Create an agent-editable starter model specification")
    new.add_argument("image", type=Path)
    new.add_argument("--id", required=True)
    new.add_argument("--output", required=True, type=Path)
    new.add_argument("--description", default="Agent-authored Minecraft reconstruction")
    new.add_argument("--complexity", choices=("simple", "moderate", "complex"), default="moderate")

    validate = commands.add_parser("validate", help="Validate a model specification")
    validate.add_argument("spec", type=Path)
    validate.add_argument("--strict", action="store_true")

    build = commands.add_parser("build", help="Compile a strict model specification")
    build.add_argument("spec", type=Path)
    build.add_argument("--output", required=True, type=Path)

    threejs = commands.add_parser(
        "preview-threejs",
        aliases=["threejs"],
        help="Export the same strict cuboid specification as a Three.js Group factory",
    )
    threejs.add_argument("spec", type=Path)
    threejs.add_argument("--output", required=True, type=Path)

    from_threejs = commands.add_parser(
        "from-threejs",
        help="Convert constrained Three.js Object3D.toJSON output into a model spec",
    )
    from_threejs.add_argument("scene", type=Path)
    from_threejs.add_argument("--reference", required=True, type=Path)
    from_threejs.add_argument("--id", required=True)
    from_threejs.add_argument("--description", required=True)
    from_threejs.add_argument("--output", required=True, type=Path)

    audit = commands.add_parser("audit", help="Audit a generated Blockbench model")
    audit.add_argument("bbmodel", type=Path)
    audit.add_argument("--output", type=Path)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "probe":
            result = image_probe(args.image)
            if args.output:
                write_json(args.output, result)
            print(json.dumps(result, indent=2, sort_keys=True))
        elif args.command == "new":
            if not ID_RE.fullmatch(args.id):
                raise ModelSpecError("id must match [a-z0-9][a-z0-9_-]{0,63}")
            result = starter_spec(
                args.image,
                args.output,
                args.id,
                args.description,
                args.complexity,
            )
            write_json(args.output, result)
            errors = validate_spec(result)
            if errors:
                raise ModelSpecError("starter generation failed:\n" + "\n".join(f"- {item}" for item in errors))
            print(json.dumps({"ok": True, "spec": str(args.output.resolve())}, indent=2))
        elif args.command == "validate":
            validated_spec(args.spec, strict=args.strict)
            print(json.dumps({"ok": True, "strict": args.strict, "spec": str(args.spec.resolve())}, indent=2))
        elif args.command == "build":
            print(json.dumps(build_model(args.spec, args.output), indent=2, sort_keys=True))
        elif args.command in {"preview-threejs", "threejs"}:
            spec = validated_spec(args.spec, strict=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(make_threejs_factory(spec), encoding="utf-8")
            print(
                json.dumps(
                    {
                        "ok": True,
                        "threejs": str(args.output.resolve()),
                        "cuboids": len(spec["cubes"]),
                    },
                    indent=2,
                )
            )
        elif args.command == "from-threejs":
            if not ID_RE.fullmatch(args.id):
                raise ModelSpecError("id must match [a-z0-9][a-z0-9_-]{0,63}")
            spec = import_threejs_scene(
                args.scene,
                args.reference,
                args.output,
                args.id,
                args.description,
            )
            write_json(args.output, spec)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "spec": str(args.output.resolve()),
                        "cuboids": len(spec["cubes"]),
                    },
                    indent=2,
                )
            )
        elif args.command == "audit":
            report = audit_bbmodel(read_json(args.bbmodel))
            if args.output:
                write_json(args.output, report)
            print(json.dumps(report, indent=2, sort_keys=True))
            if not report["ok"]:
                return 1
        return 0
    except ModelSpecError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
