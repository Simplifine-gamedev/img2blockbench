#!/usr/bin/env python3
"""Turn an official img2threejs starter spec into the Lane 3 platypus spec."""

from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
from typing import Any


MATERIALS = {
    "fur": ("#6f4525", "#4c2d1c", "#946039", 0.78),
    "fur_dark": ("#3a2417", "#24150e", "#5a3822", 0.82),
    "underfur": ("#aa8358", "#75583b", "#d7ad7a", 0.84),
    "bill": ("#4c5865", "#303944", "#718091", 0.68),
    "web": ("#46515d", "#29333d", "#687887", 0.72),
    "tail": ("#35271f", "#201711", "#554034", 0.86),
    "eye": ("#090909", "#020202", "#1d1d1d", 0.32),
    "glint": ("#f4f4ef", "#bfc2bd", "#ffffff", 0.24),
    "nostril": ("#151b22", "#070a0d", "#2b3540", 0.46),
}


PARTS = [
    ("body_main", "Main body", "macro", "long low torso", (0, 7.5, 0), (10, 7, 14), (0, 0, 0), "fur"),
    ("shoulders", "Shoulder mass", "macro", "broad shoulder block", (0, 7.4, 5), (10.5, 7.5, 5.5), (0, 0, 0), "fur"),
    ("neck", "Neck bridge", "meso", "short neck bridge", (0, 8, 7.2), (7, 5.5, 3.5), (0, 0, 0), "fur"),
    ("head_main", "Head", "macro", "broad platypus head", (0, 8.2, 9.7), (8, 7, 6.5), (0, 0, 0), "fur"),
    ("bill_base", "Bill base", "meso", "wide bill base", (0, 7.2, 13.3), (9.5, 3, 4), (0, 0, 0), "bill"),
    ("bill_tip", "Bill tip", "macro", "broad flat bill tip", (0, 6.9, 17), (10.5, 2.5, 4.5), (0, 0, 0), "bill"),
    ("tail_base", "Tail base", "macro", "wide paddle tail base", (0, 6.2, -9), (8.5, 2.2, 7), (-5, 0, 0), "tail"),
    ("tail_tip", "Tail tip", "meso", "flat paddle tail tip", (0, 5.7, -14), (8, 1.8, 6), (-8, 0, 0), "tail"),
    ("front_left_leg", "Front left leg", "meso", "front left leg", (3.7, 3.8, 4.2), (2.5, 5, 2.7), (0, 0, 0), "fur_dark"),
    ("front_left_foot", "Front left webbed foot", "meso", "front left webbed foot", (3.7, 0.9, 4.8), (4.2, 1.4, 3.8), (0, 0, 0), "web"),
    ("front_left_toe_1", "Front left outer toe", "micro", "front left toe", (2.45, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("front_left_toe_2", "Front left middle toe", "micro", "front left toe", (3.7, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("front_left_toe_3", "Front left inner toe", "micro", "front left toe", (4.95, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("front_right_leg", "Front right leg", "meso", "front right leg", (-3.7, 3.8, 4.2), (2.5, 5, 2.7), (0, 0, 0), "fur_dark"),
    ("front_right_foot", "Front right webbed foot", "meso", "front right webbed foot", (-3.7, 0.9, 4.8), (4.2, 1.4, 3.8), (0, 0, 0), "web"),
    ("front_right_toe_1", "Front right outer toe", "micro", "front right toe", (-4.95, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("front_right_toe_2", "Front right middle toe", "micro", "front right toe", (-3.7, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("front_right_toe_3", "Front right inner toe", "micro", "front right toe", (-2.45, 0.65, 6.5), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_left_leg", "Rear left leg", "meso", "rear left leg", (3.7, 3.8, -4.1), (2.5, 5, 2.7), (0, 0, 0), "fur_dark"),
    ("rear_left_foot", "Rear left webbed foot", "meso", "rear left webbed foot", (3.7, 0.9, -3.5), (4.2, 1.4, 3.8), (0, 0, 0), "web"),
    ("rear_left_toe_1", "Rear left outer toe", "micro", "rear left toe", (2.45, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_left_toe_2", "Rear left middle toe", "micro", "rear left toe", (3.7, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_left_toe_3", "Rear left inner toe", "micro", "rear left toe", (4.95, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_right_leg", "Rear right leg", "meso", "rear right leg", (-3.7, 3.8, -4.1), (2.5, 5, 2.7), (0, 0, 0), "fur_dark"),
    ("rear_right_foot", "Rear right webbed foot", "meso", "rear right webbed foot", (-3.7, 0.9, -3.5), (4.2, 1.4, 3.8), (0, 0, 0), "web"),
    ("rear_right_toe_1", "Rear right outer toe", "micro", "rear right toe", (-4.95, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_right_toe_2", "Rear right middle toe", "micro", "rear right toe", (-3.7, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("rear_right_toe_3", "Rear right inner toe", "micro", "rear right toe", (-2.45, 0.65, -1.8), (1, 0.8, 2.4), (0, 0, 0), "web"),
    ("eye_left", "Left eye", "micro", "left square eye", (4.2, 9.05, 11.15), (0.5, 1.55, 1.15), (0, 0, 0), "eye"),
    ("eye_right", "Right eye", "micro", "right square eye", (-4.2, 9.05, 11.15), (0.5, 1.55, 1.15), (0, 0, 0), "eye"),
    ("glint_left", "Left eye glint", "micro", "left eye catchlight", (4.48, 9.42, 11.42), (0.5, 0.5, 0.5), (0, 0, 0), "glint"),
    ("glint_right", "Right eye glint", "micro", "right eye catchlight", (-4.48, 9.42, 11.42), (0.5, 0.5, 0.5), (0, 0, 0), "glint"),
    ("nostril_left", "Left nostril", "micro", "left bill nostril", (2.25, 8.4, 17.35), (0.75, 0.5, 0.85), (0, 0, 0), "nostril"),
    ("nostril_right", "Right nostril", "micro", "right bill nostril", (-2.25, 8.4, 17.35), (0.75, 0.5, 0.85), (0, 0, 0), "nostril"),
]


DETAILS = [
    ("broad-bill", "contour", "Broad layered bill", "bill_tip"),
    ("bill-nostrils", "hole", "Paired square nostrils", "nostril_left"),
    ("square-eyes", "decal", "Black lateral eyes", "eye_left"),
    ("eye-glints", "gloss", "Small bright eye catchlights", "glint_left"),
    ("paddle-tail", "contour", "Wide low paddle tail", "tail_base"),
    ("long-low-body", "contour", "Long rectangular torso silhouette", "body_main"),
    ("webbed-front-feet", "ridge", "Three separated front toes", "front_left_toe_2"),
    ("webbed-rear-feet", "ridge", "Three separated rear toes", "rear_left_toe_2"),
    ("dark-lower-legs", "linework", "Dark lower limb color break", "front_left_leg"),
    ("pixel-fur", "stain", "Mottled brown square-pixel fur", "fur"),
]


def material_spec(
    material_id: str,
    base: str,
    shade: str,
    highlight: str,
    roughness: float,
) -> dict[str, Any]:
    return {
        "id": material_id,
        "name": material_id.replace("_", " ").title(),
        "type": "standard",
        "shaderModel": "MeshPhysicalMaterial",
        "baseColor": base,
        "color": base,
        "albedo": {
            "dominant": base,
            "secondary": [shade, highlight],
            "samplingNotes": "Palette sampled from the Minecraft-style reference.",
        },
        "colorVariation": {
            "palette": [base, shade, highlight],
            "pattern": "blocky mottled pixels",
            "amplitude": 0.12 if material_id not in {"eye", "glint", "nostril"} else 0.02,
            "heightCorrelation": 0.16,
        },
        "textureResolution": 128,
        "textureProjection": {
            "mode": "uv",
            "repeat": [3.0, 3.0],
            "anisotropy": 4,
            "texelDensityIntent": "Crisp low-resolution material variation.",
        },
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color zones"},
            {"id": "meso", "frequency": 8.0, "amplitude": 0.09, "role": "pixel mottling"},
            {"id": "micro", "frequency": 24.0, "amplitude": 0.025, "role": "subtle highlight breakup"},
        ],
        "roughness": {"base": roughness, "variation": 0.08, "map": "independent-procedural-field"},
        "metalness": {"base": 0.0, "variation": 0.0},
        "normal": {"pattern": "independent-height-field", "strength": 0.12, "scale": 12.0},
        "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25},
        "wear": {"edgeWear": 0.02, "scratches": [], "chips": []},
        "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": shade},
        "localOverrides": [
            {
                "id": f"{material_id}-pixel-variation",
                "description": "Reference-matched square-pixel color variation.",
                "evidenceRefs": ["full-object"],
            }
        ],
        "shaderNotes": [
            "Keep the material matte and readable under neutral turntable lighting.",
            "Use nearest-looking color steps rather than smooth organic noise.",
        ],
    }


def component_spec(part: tuple[Any, ...]) -> dict[str, Any]:
    component_id, name, level, role, position, scale, rotation_degrees, material_id = part
    base, shade, _, _ = MATERIALS[material_id]
    rotation = [math.radians(value) for value in rotation_degrees]
    local_features = [detail_id for detail_id, _, _, ref in DETAILS if ref in {component_id, material_id}]
    return {
        "id": component_id,
        "name": name,
        "level": level,
        "role": role,
        "importance": 1.0 if level == "macro" else 0.78 if level == "meso" else 0.58,
        "confidence": 0.88,
        "primitive": "box",
        "topologyClass": "assembled-solid",
        "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.",
        "geometryDescriptor": {
            "topologyIntent": "native Minecraft cuboid with hard square edges",
            "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
            "deformationStack": [],
            "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "flat cuboid normals",
        },
        "colorMaterialRecipe": {
            "dominantAlbedo": f"rgba({int(base[1:3], 16)}, {int(base[3:5], 16)}, {int(base[5:7], 16)}, 1.0)",
            "secondaryAlbedo": f"rgba({int(shade[1:3], 16)}, {int(shade[3:5], 16)}, {int(shade[5:7], 16)}, 1.0)",
            "materialClass": "skin" if material_id in {"fur", "fur_dark", "underfur"} else "rubber",
            "materialClassConfidence": 0.82,
        },
        "parent": None,
        "attachment": None,
        "dimensions": {
            "width": scale[0],
            "height": scale[1],
            "depth": scale[2],
            "units": "Blockbench units",
            "confidence": 0.9,
        },
        "transform": {
            "position": list(position),
            "rotation": rotation,
            "scale": list(scale),
        },
        "actionProfile": {
            "animationRole": component_id,
            "pivot": {
                "mode": "component-center",
                "localPosition": [0, 0, 0],
                "axis": [0, 1, 0],
                "confidence": 0.85,
            },
            "transformChannels": {
                "translate": True,
                "rotate": True,
                "scale": True,
                "bend": False,
                "twist": False,
                "detach": False,
                "visibility": True,
                "materialState": True,
            },
            "sockets": [],
            "collider": {
                "type": "box",
                "offset": [0, 0, 0],
                "scale": list(scale),
                "isTrigger": False,
            },
            "constraints": [],
            "destruction": {
                "breakable": False,
                "fractureGroup": component_id,
                "seamRefs": [],
                "detachableFragments": [],
                "breakImpulse": 0.0,
                "debrisMaterial": material_id,
            },
        },
        "material": material_id,
        "materialLayers": [material_id],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": local_features,
        "surfaceDetail": {
            "macroRoughness": 0.12,
            "microRoughness": 0.04,
            "bumpAmplitude": 0.02,
            "normalPattern": "square-pixel mottling",
            "displacementPattern": "",
            "occlusionPattern": "contact darkening",
            "edgeWearPattern": "minimal",
            "notes": "Preserve the Minecraft block silhouette.",
        },
        "evidenceRefs": ["full-object"],
        "details": local_features,
        "fidelityTier": "blockout",
    }


def prepare(template: dict[str, Any]) -> dict[str, Any]:
    spec = copy.deepcopy(template)
    component_ids = [part[0] for part in PARTS]
    assessment = spec["preSpecAssessment"]

    spec.update(
        {
            "targetId": "minecraft-platypus-img2threejs",
            "targetName": "Minecraft Platypus",
            "sourceImage": "../../reference.png",
            "suitability": "pass",
            "scores": {
                "object_isolation": 3,
                "silhouette_readability": 3,
                "depth_inference": 2,
                "primitive_decomposition": 3,
                "material_procedurality": 3,
                "occlusion_risk": 1,
                "interaction_fit": 2,
            },
            "materials": [
                material_spec(material_id, *values)
                for material_id, values in MATERIALS.items()
            ],
            "componentTree": [component_spec(part) for part in PARTS],
            "lightingFromPhoto": [
                "Warm key light from upper left with soft shadows.",
                "Cool neutral fill light from camera right.",
                "Soft environment rim light separates the dark tail and feet.",
                "Filmic tone mapping at neutral exposure.",
                "Subtle ground contact shadow beneath all four feet.",
            ],
            "viewEvidence": [
                {
                    "id": "full-object",
                    "view": "three-quarter",
                    "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1, "units": "normalized"},
                    "observations": [
                        "Full body, bill, four feet, and tail are unobstructed.",
                        "Minecraft cuboid construction is directly visible.",
                    ],
                    "confidence": 0.94,
                }
            ],
            "silhouette": {
                "boundingShape": "long low quadruped with oversized horizontal bill and paddle tail",
                "aspectRatios": ["body length approximately 2.4x body height"],
                "symmetry": "bilateral",
                "dominantCurves": ["stepped top line", "low tail taper"],
                "negativeSpaces": ["four separated legs", "clear belly gap"],
                "landmarks": ["square lateral eyes", "paired nostrils", "three toes per visible foot"],
            },
            "featureReviewTargets": [
                {
                    "id": "pose-silhouette",
                    "name": "Long low quadruped silhouette",
                    "tier": "critical",
                    "passIds": ["blockout", "structural-pass"],
                    "minimumScore": 0.8,
                    "mustPass": True,
                    "componentRefs": ["body_main", "head_main", "bill_tip", "tail_base"],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "face-landmark-placement",
                    "name": "Bill, eyes, glints, and nostrils",
                    "tier": "critical",
                    "passIds": ["form-refinement", "material-pass"],
                    "minimumScore": 0.8,
                    "mustPass": True,
                    "componentRefs": ["bill_tip", "eye_left", "eye_right", "nostril_left", "nostril_right"],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "anatomy-proportion",
                    "name": "Four legs and webbed feet",
                    "tier": "important",
                    "passIds": ["structural-pass", "form-refinement"],
                    "minimumScore": 0.72,
                    "mustPass": True,
                    "componentRefs": ["front_left_leg", "front_right_leg", "rear_left_leg", "rear_right_leg"],
                    "evidenceRefs": ["full-object"],
                },
                {
                    "id": "outfit-and-palette",
                    "name": "Brown fur, blue-gray bill, and webbed feet palette",
                    "tier": "critical",
                    "passIds": ["material-pass", "surface-pass"],
                    "minimumScore": 0.76,
                    "mustPass": True,
                    "componentRefs": ["body_main", "bill_tip", "front_left_foot", "tail_base"],
                    "evidenceRefs": ["full-object"],
                },
            ],
            "repetitionSystems": [
                {
                    "id": "paired-limbs-and-toes",
                    "type": "bilateral-repeat",
                    "componentRefs": [
                        component_id
                        for component_id in component_ids
                        if "leg" in component_id or "foot" in component_id or "toe" in component_id
                    ],
                    "count": 20,
                    "notes": "Mirrored limb and toe spacing follows the visible Minecraft reference.",
                }
            ],
            "risks": [],
            "assumptions": [
                "Hidden right-side details mirror the visible left-side structure.",
                "The generated source is constrained to boxes so conversion remains lossless.",
            ],
        }
    )

    object_class = assessment["objectClass"]
    object_class.update(
        {
            "primaryType": "stylized Minecraft quadruped",
            "primaryDomain": "hybrid",
            "formLanguage": ["cuboid", "blocky", "bilateral", "low-profile"],
            "structureKind": ["assembled creature", "articulated quadruped"],
            "motionPotential": ["walk", "tail pitch", "head pitch"],
            "materialFamilies": ["matte fur", "rubbery bill", "webbed feet"],
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
                "macroComponents": 6,
                "mesoComponents": 12,
                "microFeatureGroups": 16,
                "materialLayers": len(MATERIALS),
                "repetitionSystems": 1,
            },
            "reasoning": [
                "The reference clearly exposes a compound cuboid creature with repeated limbs, toes, and facial details."
            ],
        }
    )
    assessment["detailInventory"] = {
        "scanMethod": "component-zones",
        "targetMinDetails": len(DETAILS),
        "note": "Details were inventoried from head, body, tail, and feet zones.",
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
            for detail_id, kind, description, ref in DETAILS
        ],
    }
    assessment["anatomy"] = {
        "applies": True,
        "styleHeads": 3.0,
        "proportions": {
            "headUnit": 6.5,
            "torso": 2.2,
            "legs": 0.8,
            "shoulderWidth": 1.6,
            "hipWidth": 1.5,
        },
        "pose": {"type": "neutral quadruped", "jointAngles": {}},
        "faceLandmarks": {
            "eyeLine": 0.42,
            "eyeSpacing": 1.25,
            "noseBase": 0.67,
            "mouthLine": 0.72,
            "hairline": 0.0,
        },
        "features": ["broad bill", "square side eyes", "paired nostrils", "paddle tail"],
        "confidence": 0.86,
        "note": "Head-unit values describe the stylized quadruped rather than a humanoid.",
    }
    assessment["sourceImage"] = "../../reference.png"

    spec["qualityTargets"]["reviewViewpoints"] = [
        "front",
        "left",
        "right",
        "three-quarter",
        "top",
    ]
    spec["qualityContract"]["minimumSpecDepth"] = {
        "macroComponents": 5,
        "mesoComponents": 10,
        "microFeatureGroups": 10,
        "materialLayers": 6,
        "repetitionSystems": 1,
        "reviewViewpoints": 5,
    }
    spec["qualityContract"]["definitionOfDone"] = [
        "The procedural result preserves the reference silhouette, broad bill, paddle tail, four webbed feet, facial landmarks, and Minecraft palette.",
        "Every generated geometry node remains a BoxGeometry compatible with deterministic Blockbench conversion.",
    ]
    spec["lookDevTargets"]["qualityPriority"] = "balanced"
    spec["lookDevTargets"]["materialPass"].update(
        {
            "minimumTextureResolution": 64,
            "preferredTextureResolution": 128,
            "referencePbrExtraction": {
                "requiredWhenSourceImagePresent": False,
                "targetThreshold": 0.7,
                "stopOnLowConfidence": False,
                "acceptedLimitation": "This benchmark tests procedural geometry cost, not single-view PBR recovery.",
            },
        }
    )
    spec["performanceBudget"].update(
        {
            "targetTriangles": 20_000,
            "maxDrawCalls": 48,
            "textureSize": 128,
            "fpsTarget": 60,
            "optimizationPolicy": "Keep all identity-defining cuboids; reduce procedural texture resolution first.",
        }
    )

    for build_pass in spec["buildPasses"]:
        build_pass["componentRefs"] = component_ids
    spec["sculptPipeline"]["currentPass"] = "blockout"
    spec["sculptPipeline"]["completedPasses"] = []
    spec["sculptPipeline"]["lastCompletedPass"] = ""
    spec["reviewHistory"] = []
    return spec


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    template = json.loads(args.template.read_text(encoding="utf-8"))
    output = prepare(template)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
