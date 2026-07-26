#!/usr/bin/env python3
"""Synchronize repaired Lane 2 models with their deterministic delivery bundles."""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


ANIMALS = ("platypus", "chimpanzee", "elephant", "tiger", "coyote")
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    for animal in ANIMALS:
        lane = root / "examples" / animal / "lane2"
        build = root / "examples" / animal / "build"
        stem = f"{animal}_lane2"

        model = (lane / f"{animal}.bbmodel").read_bytes()
        texture = (lane / f"{animal}.png").read_bytes()
        geometry = (lane / f"{animal}.geo.json").read_bytes()
        model_audit = (build / f"{animal}.audit.json").read_bytes()
        source_audit = (build / f"{animal}.source-audit.json").read_bytes()

        shutil.copyfile(lane / f"{animal}.bbmodel", build / f"{animal}.bbmodel")
        shutil.copyfile(lane / f"{animal}.png", build / f"{animal}.png")

        manifest_path = build / f"{animal}.manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries = {
            f"{stem}.bbmodel": model,
            f"{stem}.geo.json": geometry,
            f"{stem}.png": texture,
            "model-audit.json": model_audit,
            "source-audit.json": source_audit,
        }
        manifest["files"] = {
            name: sha256(data)
            for name, data in sorted(entries.items())
        }
        manifest_data = (
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        manifest_path.write_bytes(manifest_data)

        for destination in (lane / f"{animal}.zip", build / f"{animal}.zip"):
            with zipfile.ZipFile(destination, "w") as archive:
                zip_entry(archive, "manifest.json", manifest_data)
                for name, data in sorted(entries.items()):
                    zip_entry(archive, name, data)
        print(animal)


if __name__ == "__main__":
    main()
