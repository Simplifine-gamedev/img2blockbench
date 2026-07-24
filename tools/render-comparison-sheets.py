#!/usr/bin/env python3
"""Render the five-animal reference/output sheet for each benchmark lane."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ANIMALS = ("platypus", "chimpanzee", "elephant", "tiger", "coyote")
LANES = {
    "lane1": "DIRECT",
    "lane2": "TRELLIS",
    "lane3": "IMG2THREEJS",
}
WIDTH = 1540
MARGIN = 18
CELL_WIDTH = (WIDTH - MARGIN * 2) // len(ANIMALS)
HEADER_HEIGHT = 78
ROW_HEIGHT = 246
HEIGHT = HEADER_HEIGHT + ROW_HEIGHT * 2 + MARGIN


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in names:
        path = Path(name)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def cover(path: Path, width: int, height: int) -> Image.Image:
    with Image.open(path) as image:
        return ImageOps.fit(
            image.convert("RGB"),
            (width, height),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )


def render_lane(lane: str, label: str) -> Path:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), "#111820")
    draw = ImageDraw.Draw(canvas)
    title_font = font(16, bold=True)
    animal_font = font(20)
    badge_font = font(12, bold=True)

    draw.text(
        (MARGIN, 13),
        f"IMG2BLOCKBENCH  /  LANE {lane[-1]}  /  {label}",
        fill="#ff7a18",
        font=title_font,
    )

    for index, animal in enumerate(ANIMALS):
        x = MARGIN + index * CELL_WIDTH
        draw.text(
            (x + CELL_WIDTH / 2, 49),
            animal.upper(),
            fill="#f5f7f8",
            font=animal_font,
            anchor="mm",
        )

        reference = cover(
            ROOT / "examples" / animal / "reference.png",
            CELL_WIDTH,
            ROW_HEIGHT,
        )
        output = cover(
            ROOT / "examples" / animal / lane / "render.png",
            CELL_WIDTH,
            ROW_HEIGHT,
        )
        canvas.paste(reference, (x, HEADER_HEIGHT))
        canvas.paste(output, (x, HEADER_HEIGHT + ROW_HEIGHT))

        badge = f"LANE {lane[-1]}  {label}"
        badge_box = draw.textbbox((0, 0), badge, font=badge_font)
        badge_width = badge_box[2] - badge_box[0] + 16
        badge_height = badge_box[3] - badge_box[1] + 10
        badge_y = HEADER_HEIGHT + ROW_HEIGHT + 10
        draw.rectangle(
            (x + 10, badge_y, x + 10 + badge_width, badge_y + badge_height),
            fill="#111820",
        )
        draw.text(
            (x + 18, badge_y + badge_height / 2),
            badge,
            fill="#ff7a18",
            font=badge_font,
            anchor="lm",
        )

        if index:
            draw.line(
                (x, HEADER_HEIGHT, x, HEADER_HEIGHT + ROW_HEIGHT * 2),
                fill="#e5e7e8",
                width=1,
            )

    output_path = ROOT / "examples" / f"five-animals-{lane}.png"
    canvas.save(output_path, optimize=True)
    return output_path


def main() -> None:
    for lane, label in LANES.items():
        print(render_lane(lane, label))


if __name__ == "__main__":
    main()
