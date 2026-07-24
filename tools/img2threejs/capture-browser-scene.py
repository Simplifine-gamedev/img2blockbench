#!/usr/bin/env python3
"""Capture an img2threejs browser exporter as Object3D.toJSON output."""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--chrome",
        type=Path,
        default=Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    )
    args = parser.parse_args()

    result = subprocess.run(
        [
            str(args.chrome),
            "--headless=new",
            "--disable-gpu-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--virtual-time-budget=10000",
            "--dump-dom",
            args.url,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.search(r"<body[^>]*>(.*)</body>", result.stdout, flags=re.DOTALL)
    if not match:
        raise RuntimeError("Exporter page did not produce a body")
    payload = html.unescape(match.group(1)).strip()
    scene = json.loads(payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(scene, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(args.output)


if __name__ == "__main__":
    main()
