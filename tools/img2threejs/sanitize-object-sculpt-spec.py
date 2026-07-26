#!/usr/bin/env python3
"""Remove texture-only parts from an img2threejs ObjectSculptSpec."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def remove_refs(value: Any, removed: set[str]) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if key.endswith("Refs") and isinstance(item, list):
                result[key] = [
                    ref for ref in item if not isinstance(ref, str) or ref not in removed
                ]
            else:
                result[key] = remove_refs(item, removed)
        return result
    if isinstance(value, list):
        return [remove_refs(item, removed) for item in value]
    return value


def sanitize(spec: dict[str, Any], removed: set[str]) -> dict[str, Any]:
    output = remove_refs(json.loads(json.dumps(spec)), removed)
    output["componentTree"] = [
        component
        for component in output["componentTree"]
        if component.get("id") not in removed
    ]

    assessment = output.get("preSpecAssessment", {})
    inventory = assessment.get("detailInventory", {})
    details = inventory.get("details", [])
    if isinstance(details, list):
        inventory["details"] = [
            detail
            for detail in details
            if detail.get("mapsTo", {}).get("ref") not in removed
        ]
        inventory["targetMinDetails"] = len(inventory["details"])

    counts = {"macro": 0, "meso": 0, "micro": 0}
    for component in output["componentTree"]:
        level = component.get("level")
        if level in counts:
            counts[level] += 1
    complexity = assessment.get("complexity", {}).get("estimatedCounts", {})
    complexity.update(
        {
            "macroComponents": counts["macro"],
            "mesoComponents": counts["meso"],
            "microFeatureGroups": counts["micro"],
        }
    )
    minimums = output.get("qualityContract", {}).get(
        "minimumSpecDepth",
        {},
    )
    minimums.update(
        {
            "macroComponents": max(1, counts["macro"] - 1),
            "mesoComponents": max(1, counts["meso"] - 2),
            "microFeatureGroups": max(0, counts["micro"] - 1),
        }
    )
    output.setdefault("qualityContract", {}).setdefault(
        "definitionOfDone",
        [],
    ).append(
        "Flat eyes, nostrils, inner-ear paint, brows, and markings are texture features rather than geometry."
    )
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--animal", required=True)
    parser.add_argument("--recipes", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    recipes_path = args.recipes or Path(__file__).with_name(
        "semantic-recipes.json"
    )
    recipes = json.loads(recipes_path.read_text(encoding="utf-8"))
    recipe = recipes.get(args.animal)
    if not isinstance(recipe, dict):
        raise RuntimeError(f"Missing semantic recipe for {args.animal}")

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    output = sanitize(spec, set(recipe["texture_only_components"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output)


if __name__ == "__main__":
    main()
