#!/usr/bin/env python3
"""Prepare a strict official img2threejs spec from an animal blueprint."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
from typing import Any


def load_platypus_helpers() -> Any:
    helper_path = Path(__file__).with_name("prepare-platypus-spec.py")
    module_spec = importlib.util.spec_from_file_location(
        "img2blockbench_platypus_spec_helpers",
        helper_path,
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"Unable to load {helper_path}")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def prepare(
    template: dict[str, Any],
    blueprint: dict[str, Any],
) -> dict[str, Any]:
    helpers = load_platypus_helpers()
    helpers.MATERIALS = {
        material_id: tuple(values)
        for material_id, values in blueprint["materials"].items()
    }
    helpers.PARTS = [tuple(part) for part in blueprint["parts"]]
    helpers.DETAILS = [tuple(detail) for detail in blueprint["details"]]

    spec = helpers.prepare(copy.deepcopy(template))
    animal_id = blueprint["id"]
    target_name = blueprint["name"]
    component_ids = [part[0] for part in helpers.PARTS]
    macro_refs = [part[0] for part in helpers.PARTS if part[2] == "macro"]
    meso_refs = [part[0] for part in helpers.PARTS if part[2] == "meso"]
    micro_refs = [part[0] for part in helpers.PARTS if part[2] == "micro"]
    repeat_refs = [
        component_id
        for component_id in component_ids
        if any(token in component_id for token in blueprint["repeatTokens"])
    ]

    spec.update(
        {
            "targetId": f"minecraft-{animal_id}-img2threejs",
            "targetName": target_name,
            "sourceImage": "../../reference.png",
            "componentTree": [
                helpers.component_spec(part)
                for part in helpers.PARTS
            ],
            "materials": [
                helpers.material_spec(material_id, *values)
                for material_id, values in helpers.MATERIALS.items()
            ],
            "silhouette": {
                "boundingShape": blueprint["silhouette"],
                "aspectRatios": blueprint["aspectRatios"],
                "symmetry": "bilateral",
                "dominantCurves": blueprint["dominantCurves"],
                "negativeSpaces": blueprint["negativeSpaces"],
                "landmarks": blueprint["landmarks"],
            },
            "featureReviewTargets": [
                {
                    "id": "pose-silhouette",
                    "name": blueprint["silhouette"],
                    "tier": "critical",
                    "passIds": ["blockout", "structural-pass"],
                    "minimumScore": 0.8,
                    "mustPass": True,
                    "componentRefs": macro_refs[:6],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "face-landmark-placement",
                    "name": blueprint["faceTarget"],
                    "tier": "critical",
                    "passIds": ["form-refinement", "material-pass"],
                    "minimumScore": 0.8,
                    "mustPass": True,
                    "componentRefs": blueprint["faceRefs"],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "anatomy-proportion",
                    "name": blueprint["anatomyTarget"],
                    "tier": "important",
                    "passIds": ["structural-pass", "form-refinement"],
                    "minimumScore": 0.72,
                    "mustPass": True,
                    "componentRefs": blueprint["anatomyRefs"],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "outfit-and-palette",
                    "name": blueprint["paletteTarget"],
                    "tier": "critical",
                    "passIds": ["material-pass", "surface-pass"],
                    "minimumScore": 0.76,
                    "mustPass": True,
                    "componentRefs": blueprint["paletteRefs"],
                    "evidenceRefs": ["full-object"],
                },
            ],
            "repetitionSystems": [
                {
                    "id": "paired-anatomy",
                    "type": "bilateral-repeat",
                    "componentRefs": repeat_refs,
                    "count": len(repeat_refs),
                    "notes": "Mirrored anatomy follows the visible Minecraft reference.",
                }
            ],
            "assumptions": [
                "Hidden right-side details mirror the visible left-side structure.",
                "The generated source is constrained to boxes so conversion remains lossless.",
            ],
            "risks": [
                "A single three-quarter image leaves hidden surfaces inferred by symmetry.",
            ],
        }
    )
    spec["lookDevTargets"]["qualityPriority"] = "reference-fidelity"
    spec["lookDevTargets"]["materialPass"].update(
        {
            "minimumTextureResolution": 256,
            "preferredTextureResolution": 256,
            "referencePbrExtraction": {
                "requiredWhenSourceImagePresent": False,
                "targetThreshold": 0.7,
                "stopOnLowConfidence": False,
                "acceptedLimitation": (
                    "The Minecraft BBModel target preserves albedo only. "
                    "Reference pixels are baked into cuboid faces by the "
                    "img2blockbench adapter; Three.js PBR maps remain preview-only."
                ),
            },
        }
    )
    for material in spec["materials"]:
        material["textureResolution"] = 256
    spec["performanceBudget"]["textureSize"] = 256

    components_by_level = {
        level: [
            component["id"]
            for component in spec["componentTree"]
            if component["level"] == level
        ]
        for level in ("macro", "meso", "micro")
    }
    pass_components = {
        "blockout": components_by_level["macro"],
        "structural-pass": components_by_level["meso"],
        "form-refinement": components_by_level["micro"],
    }
    for build_pass in spec["buildPasses"]:
        build_pass["componentRefs"] = pass_components.get(
            build_pass["id"],
            [],
        )

    assessment = spec["preSpecAssessment"]
    assessment["objectClass"].update(
        {
            "primaryType": blueprint["primaryType"],
            "primaryDomain": "hybrid",
            "formLanguage": blueprint["formLanguage"],
            "structureKind": blueprint["structureKind"],
            "motionPotential": blueprint["motionPotential"],
            "materialFamilies": blueprint["materialFamilies"],
            "notes": "A creature represented with explicit Minecraft cuboids.",
        }
    )
    assessment["complexity"].update(
        {
            "tier": "complex",
            "scores": {
                "silhouetteComplexity": 2,
                "componentCount": 3,
                "hierarchyDepth": 2,
                "repetitionDensity": 3,
                "materialLayerCount": 2,
                "localDetailDensity": 2,
                "occlusionRisk": 1,
                "actionReadinessNeed": 2,
            },
            "estimatedCounts": {
                "macroComponents": len(macro_refs),
                "mesoComponents": len(meso_refs),
                "microFeatureGroups": len(micro_refs),
                "materialLayers": len(helpers.MATERIALS),
                "repetitionSystems": 1,
            },
            "reasoning": [
                "The reference exposes a compound cuboid creature with repeated limbs and facial details."
            ],
        }
    )
    assessment["detailInventory"] = {
        "scanMethod": "component-zones",
        "targetMinDetails": len(helpers.DETAILS),
        "note": "Details were inventoried from face, torso, limbs, and tail zones.",
        "details": [
            {
                "id": detail_id,
                "kind": kind,
                "description": description,
                "region": {"units": "normalized"},
                "scale": "micro" if kind in {"hole", "decal", "gloss"} else "meso",
                "affects": "identity",
                "mapsTo": {"type": "component-or-material", "ref": ref},
                "evidenceRef": "full-object",
                "confidence": 0.88,
            }
            for detail_id, kind, description, ref in helpers.DETAILS
        ],
    }
    assessment["anatomy"] = {
        "applies": True,
        "styleHeads": blueprint["styleHeads"],
        "proportions": blueprint["proportions"],
        "pose": {"type": blueprint["pose"], "jointAngles": {}},
        "faceLandmarks": blueprint["faceLandmarks"],
        "features": blueprint["features"],
        "confidence": 0.86,
        "note": "Head-unit values describe the stylized animal rather than a humanoid.",
    }
    assessment["sourceImage"] = "../../reference.png"

    spec["qualityContract"]["minimumSpecDepth"] = {
        "macroComponents": max(4, len(macro_refs) - 1),
        "mesoComponents": max(8, len(meso_refs) - 2),
        "microFeatureGroups": max(2, len(micro_refs) - 1),
        "materialLayers": max(4, len(helpers.MATERIALS) - 1),
        "repetitionSystems": 1,
        "reviewViewpoints": 5,
    }
    spec["qualityContract"]["definitionOfDone"] = [
        blueprint["definitionOfDone"],
        "Every generated geometry node remains a BoxGeometry compatible with deterministic Blockbench conversion.",
    ]
    return spec


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("blueprint", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    template = json.loads(args.template.read_text(encoding="utf-8"))
    blueprint = json.loads(args.blueprint.read_text(encoding="utf-8"))
    output = prepare(template, blueprint)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
