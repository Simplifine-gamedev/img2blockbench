#!/usr/bin/env python3
"""Replace flat Three.js detail boxes with Blockbench texture landmarks."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any


def load_compiler(root: Path) -> Any:
    path = root / "skill" / "img2blockbench" / "scripts" / "img2blockbench.py"
    module_spec = importlib.util.spec_from_file_location(
        "img2blockbench_semanticize",
        path,
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"Unable to load compiler: {path}")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def semanticize(
    spec: dict[str, Any],
    recipe: dict[str, Any],
) -> dict[str, Any]:
    removed_names = set(recipe["remove_cubes"])
    output = json.loads(json.dumps(spec))
    output["cubes"] = [
        cube for cube in output["cubes"] if cube["name"] not in removed_names
    ]

    used_bones = {cube["bone"] for cube in output["cubes"]}
    changed = True
    while changed:
        changed = False
        parents = {
            bone["parent"]
            for bone in output["bones"]
            if bone.get("parent") is not None
        }
        retained = []
        for bone in output["bones"]:
            name = bone["name"]
            if (
                name != "root"
                and name not in used_bones
                and name not in parents
            ):
                changed = True
                continue
            retained.append(bone)
        output["bones"] = retained

    existing_bones = {bone["name"] for bone in output["bones"]}
    for bone in output["bones"]:
        if (
            bone["name"] != "root"
            and bone.get("parent") not in existing_bones
        ):
            bone["parent"] = "root"

    output["landmarks"] = recipe["landmarks"]
    output.setdefault("generation", {}).update(
        {
            "semantic_texture_repair": {
                "version": 1,
                "removed_flat_detail_cuboids": sorted(removed_names),
                "texture_landmarks": len(recipe["landmarks"]),
            }
        }
    )
    output["quality_contract"]["target_cuboids"] = [
        max(1, len(output["cubes"]) - 4),
        min(96, len(output["cubes"]) + 4),
    ]
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--animal", required=True)
    parser.add_argument("--recipes", type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    recipes_path = args.recipes or Path(__file__).with_name(
        "semantic-recipes.json"
    )
    recipes = json.loads(recipes_path.read_text(encoding="utf-8"))
    if args.animal not in recipes:
        raise RuntimeError(f"Missing semantic recipe for {args.animal}")

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    output = semanticize(spec, recipes[args.animal])
    if args.reference is not None:
        output["reference"]["image"] = Path(
            os.path.relpath(
                args.reference.resolve(),
                args.output.parent.resolve(),
            )
        ).as_posix()
    compiler = load_compiler(root)
    errors = compiler.validate_spec(output, strict=True)
    if errors:
        raise RuntimeError(
            "Semanticized specification is invalid:\n"
            + "\n".join(f"- {error}" for error in errors)
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output)


if __name__ == "__main__":
    main()
