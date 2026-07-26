#!/usr/bin/env python3
"""Write relative, reproducible Lane 3 provenance for one benchmark animal."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


UPSTREAM_COMMIT = "c9077d5ecce834f6802d6742b4a5b2c682d6279d"


def record(path: Path, relative_to: Path) -> dict[str, object]:
    return {
        "path": path.relative_to(relative_to).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("animal")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    root = args.root.resolve()
    lane_dir = root / "examples" / args.animal / "lane3"
    factories = sorted(lane_dir.glob("*.generated.ts"))
    if len(factories) != 1:
        raise RuntimeError(f"Expected one generated factory in {lane_dir}")

    scene = lane_dir / f"{args.animal}.img2threejs.three.json"
    blockbench = lane_dir / "blockbench"
    bbmodel = blockbench / f"{args.animal}-lane3.bbmodel"
    atlas = blockbench / f"{args.animal}-lane3.png"
    scene_payload = json.loads(scene.read_text(encoding="utf-8"))
    transfer_path = lane_dir / "projection-audit.json"
    transfer = json.loads(transfer_path.read_text(encoding="utf-8"))
    relative_to = lane_dir

    payload = {
        "upstream": {
            "repository": "https://github.com/hoainho/img2threejs",
            "commit": UPSTREAM_COMMIT,
            "license": "Apache-2.0",
            "generator": "forge/stage3_build/generate_threejs_factory.py",
            "generated_pass": "optimization-pass",
        },
        "reference": "../reference.png",
        "spec": "img2threejs-spec.json",
        "generated_factory": record(factories[0], relative_to),
        "threejs_scene": record(scene, relative_to),
        "texture_transfer": {
            **record(transfer_path, relative_to),
            "algorithm": transfer["algorithm"],
            "source": transfer["source"],
            "mapped_material_count": transfer["mapped_material_count"],
            "reference_projection": transfer["reference_projection"],
        },
        "blockbench_model": record(bbmodel, relative_to),
        "blockbench_atlas": {
            **record(atlas, relative_to),
            "source": (
                f"{transfer['mapped_material_count']} img2threejs "
                "MeshPhysicalMaterial base-color maps"
            ),
            "threejs_materials": len(scene_payload.get("materials", [])),
        },
    }
    blueprint = root / "tools" / "img2threejs" / "blueprints" / f"{args.animal}.json"
    if blueprint.exists():
        payload["agent_blueprint"] = (
            "../../../tools/img2threejs/blueprints/" + blueprint.name
        )

    (lane_dir / "provenance.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(lane_dir / "provenance.json")


if __name__ == "__main__":
    main()
