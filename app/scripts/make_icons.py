"""Draw the app icon ("Carta" style) and write every size the PWA and iOS need.

    python -I scripts/make_icons.py        (from app/; also: npm run icons)

The design: a white sheet of paper with a folded corner, outlined in ink blue, with one text
line marked by the highlighter-yellow accent, on a soft light rounded square. It is drawn once
at 1024 px and downscaled with LANCZOS, so the edges come out smooth at every size.

Writes into public/icons/:
  icon-192.png, icon-512.png   purpose "any": rounded square, transparent corners
  icon-maskable-512.png        purpose "maskable": full-bleed background, artwork scaled into
                               the central 80% safe zone (Android crops it to any shape)
  apple-touch-icon.png         180x180, opaque (iOS adds its own rounded corners)
  icon.svg                     the same design as SVG (favicon), written from the same numbers

The geometry below is the single source of truth: change it here and re-run the script.
Needs Pillow (pip install pillow).
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

# Palette ("Carta").
BACKGROUND = "#eef1f7"
PAPER = "#ffffff"
INK = "#2747d8"
INK_SOFT = "#a9b5ef"  # the lines that are not highlighted
FLAP = "#dfe5fb"  # the folded corner, a light tint of the ink
HIGHLIGHT = "#ffd400"

# Geometry on a 1024 x 1024 canvas.
SIZE = 1024
CORNER = 224  # radius of the background's rounded square (about 22%, like iOS)
X0, Y0, X1, Y1 = 252, 172, 772, 852  # the sheet
SHEET_RADIUS = 56  # rounded sheet corners (all but the folded one)
FOLD = 168  # size of the folded corner
STROKE = 40  # outline width
LINE = 36  # text line thickness (round caps)
TEXT_X = 336  # where the text lines start
# Text lines: (y, x end, highlighted). The highlighted one sits on the yellow bar.
LINES = [(420, 600, False), (540, 688, True), (660, 640, False)]
BAR = (304, 488, 720, 592)  # x0, y0, x1, y1 of the highlighter bar
BAR_RADIUS = 14


def sheet_outline(steps: int = 24) -> list[tuple[float, float]]:
    """The sheet's contour, clockwise from the middle of the top edge, as a closed polyline.

    The rounded corners are sampled as arcs; the folded corner is a straight diagonal.
    """
    r = SHEET_RADIUS

    def arc(cx: float, cy: float, start_deg: float) -> list[tuple[float, float]]:
        # Quarter circle, clockwise on screen (y points down), starting at start_deg.
        return [
            (cx + r * math.cos(math.radians(start_deg + 90 * i / steps)),
             cy + r * math.sin(math.radians(start_deg + 90 * i / steps)))
            for i in range(steps + 1)
        ]

    pts = [((X0 + X1 - FOLD) / 2, Y0), (X1 - FOLD, Y0), (X1, Y0 + FOLD)]
    pts += arc(X1 - r, Y1 - r, 0)  # bottom right
    pts += arc(X0 + r, Y1 - r, 90)  # bottom left
    pts += arc(X0 + r, Y0 + r, 180)  # top left
    pts.append(pts[0])
    return pts


def draw_icon(scale: float = 1.0, rounded: bool = True) -> Image.Image:
    """Render the icon at 1024 px. `scale` shrinks the artwork around the centre (maskable);
    `rounded` gives the background rounded, transparent corners instead of full bleed."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = SIZE / 2

    def p(x: float, y: float) -> tuple[float, float]:
        return (c + (x - c) * scale, c + (y - c) * scale)

    def box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        return (*p(x0, y0), *p(x1, y1))

    def stroke(points: list[tuple[float, float]], width: float, color: str) -> None:
        # Pillow's wide lines have square ends; a dot on every corner makes the joins round,
        # like stroke-linejoin="round" in the SVG.
        d.line(points, fill=color, width=round(width), joint="curve")
        half = width / 2
        for x, y in points:
            d.ellipse((x - half, y - half, x + half, y + half), fill=color)

    if rounded:
        d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=CORNER, fill=BACKGROUND)
    else:
        d.rectangle((0, 0, SIZE, SIZE), fill=BACKGROUND)

    # The sheet: paper, then its ink outline.
    outline = [p(x, y) for x, y in sheet_outline()]
    d.polygon(outline, fill=PAPER)
    stroke(outline, STROKE * scale, INK)

    # The folded corner.
    flap = [p(X1 - FOLD, Y0), p(X1 - FOLD, Y0 + FOLD), p(X1, Y0 + FOLD)]
    d.polygon(flap, fill=FLAP)
    stroke(flap + [flap[0]], STROKE * scale, INK)

    # The highlighter bar, then the text lines (capsules = lines with round caps).
    d.rounded_rectangle(box(*BAR), radius=BAR_RADIUS * scale, fill=HIGHLIGHT)
    half = LINE / 2
    for y, x_end, marked in LINES:
        d.rounded_rectangle(box(TEXT_X - half, y - half, x_end + half, y + half),
                            radius=half * scale, fill=INK if marked else INK_SOFT)
    return img


def svg() -> str:
    """The same design as SVG. Hand-written markup, filled in from the constants above."""
    r, f = SHEET_RADIUS, FOLD
    sheet = (f"M{X0 + r} {Y0}H{X1 - f}L{X1} {Y0 + f}V{Y1 - r}"
             f"A{r} {r} 0 0 1 {X1 - r} {Y1}H{X0 + r}"
             f"A{r} {r} 0 0 1 {X0} {Y1 - r}V{Y0 + r}"
             f"A{r} {r} 0 0 1 {X0 + r} {Y0}Z")
    flap = f"M{X1 - f} {Y0}V{Y0 + f}H{X1}Z"
    bx0, by0, bx1, by1 = BAR
    lines = "\n".join(
        f'    <path d="M{TEXT_X} {y}H{x_end}" stroke="{INK if marked else INK_SOFT}"/>'
        for y, x_end, marked in LINES
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <!-- Generated by scripts/make_icons.py: edit the geometry there, then run npm run icons. -->
  <rect width="{SIZE}" height="{SIZE}" rx="{CORNER}" fill="{BACKGROUND}"/>
  <g stroke="{INK}" stroke-width="{STROKE}" stroke-linejoin="round">
    <path d="{sheet}" fill="{PAPER}"/>
    <path d="{flap}" fill="{FLAP}"/>
  </g>
  <rect x="{bx0}" y="{by0}" width="{bx1 - bx0}" height="{by1 - by0}" rx="{BAR_RADIUS}" fill="{HIGHLIGHT}"/>
  <g stroke-width="{LINE}" stroke-linecap="round">
{lines}
  </g>
</svg>
"""


def save_png(img: Image.Image, size: int, name: str, opaque: bool = False) -> None:
    out = img.resize((size, size), Image.Resampling.LANCZOS)
    if opaque:
        out = out.convert("RGB")
    out.save(OUT / name, optimize=True)
    print(f"  {name} ({size}x{size})")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Writing icons to {OUT}")
    any_icon = draw_icon()
    save_png(any_icon, 512, "icon-512.png")
    save_png(any_icon, 192, "icon-192.png")
    # Maskable: full bleed, artwork inside the central 80% (the safe circle has a 40% radius).
    save_png(draw_icon(scale=0.8, rounded=False), 512, "icon-maskable-512.png")
    # iOS ignores transparency (it would turn black) and rounds the corners itself.
    save_png(draw_icon(rounded=False), 180, "apple-touch-icon.png", opaque=True)
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8", newline="\n")
    print("  icon.svg")


if __name__ == "__main__":
    main()
