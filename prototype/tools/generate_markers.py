"""
Generate every printable ArUco marker for the floor plan prototype.

Outputs (in ../print/):
  plan_print.png / .pdf   rotated landscape plan, lightened, with the 4 corner
                          markers (IDs 0-3) built into the margins
  tokens.png / .pdf       letter sheet of booking tokens with labels and cut lines
  corners.png / .pdf      the 4 corner markers on their own (spares)
And ../plan.json, which tells the browser where the corner markers sit in
floor plan coordinates. Re-run this script if you change the marker layout.

Dictionary: DICT_4X4_50 everywhere. The browser uses js-aruco2's
ARUCO_4X4_1000, whose first 50 codes are identical to DICT_4X4_50.

Usage:  python3 tools/generate_markers.py
"""

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PLAN_SRC = ROOT / "assets" / "floor-plan.png"
OUT = ROOT / "print"

DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

# Corner markers, in floor plan pixels (the source PNG is 3952 x 5194).
CORNER_SIZE = 560   # marker side incl. its black border
CORNER_GAP = 80     # white quiet zone between plan and marker
CORNER_IDS = {0: "top-left", 1: "top-right", 2: "bottom-right", 3: "bottom-left"}

# Print target: 11 x 17 tabloid, landscape. The printable area leaves 0.25 in
# for printers that can't print to the edge.
SHEET_IN = (17, 11)
SAFE_MARGIN_IN = 0.25

# Booking tokens. One token per duration (open question 4, simplest answer).
TOKEN_GROUPS = [(30, range(10, 18)), (60, range(20, 28)), (90, range(30, 38))]
TOKEN_DPI = 300
TOKEN_MARKER_IN = 0.75  # small rooms (Phone Booth) are under 0.75 in tall on 11 x 17


def font(px):
    for name in ("/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            pass
    return ImageFont.load_default()


def marker(mid, px):
    return Image.fromarray(cv2.aruco.generateImageMarker(DICTIONARY, mid, px)).convert("L")


def lighten(img, strength=0.5):
    """Print the plan in light gray so markers and projected color stand out."""
    a = np.asarray(img.convert("L"), dtype=np.float32)
    return Image.fromarray((255 - (255 - a) * strength).astype(np.uint8))


def save_pdf(img, path, dpi):
    img.convert("RGB").save(path, "PDF", resolution=dpi)


def build_plan():
    plan = lighten(Image.open(PLAN_SRC))
    w, h = plan.size
    # Markers go above and below the portrait plan (left and right once rotated), so
    # they use the spare width of the 17 in side instead of shrinking the plan.
    m = CORNER_GAP * 2 + CORNER_SIZE
    canvas = Image.new("L", (w, h + 2 * m), 255)
    canvas.paste(plan, (0, m))

    inset = CORNER_GAP + CORNER_SIZE / 2       # marker center in from the plan's side edge
    off = CORNER_GAP + CORNER_SIZE / 2         # marker center out from the plan's top/bottom
    centers = {0: (inset, -off), 1: (w - inset, -off), 2: (w - inset, h + off), 3: (inset, h + off)}
    for mid, (cx, cy) in centers.items():
        canvas.paste(marker(mid, CORNER_SIZE), (int(cx - CORNER_SIZE / 2), int(cy + m - CORNER_SIZE / 2)))

    d = ImageDraw.Draw(canvas)
    d.rectangle([0, m, w - 1, m + h], outline=200, width=4)
    d.text((w / 2, h + m + m / 2), "3rd floor  ·  11 x 17  ·  print at actual size",
           fill=150, font=font(70), anchor="mm")

    # Rotate 90° clockwise so the portrait plan fills a landscape camera frame,
    # then center it on a full 17 x 11 page so "actual size" printing is exact.
    rotated = canvas.rotate(-90, expand=True)
    safe = (SHEET_IN[0] - 2 * SAFE_MARGIN_IN, SHEET_IN[1] - 2 * SAFE_MARGIN_IN)
    dpi = max(rotated.width / safe[0], rotated.height / safe[1])
    page = Image.new("L", (round(SHEET_IN[0] * dpi), round(SHEET_IN[1] * dpi)), 255)
    page.paste(rotated, ((page.width - rotated.width) // 2, (page.height - rotated.height) // 2))
    page.save(OUT / "plan_print.png", dpi=(dpi, dpi))
    save_pdf(page, OUT / "plan_print.pdf", dpi)

    meta = {
        "image": "assets/floor-plan.png",
        "width": w,
        "height": h,
        "printRotation": 90,
        "sheet": f"{SHEET_IN[1]}x{SHEET_IN[0]}",
        "markerSize": CORNER_SIZE,
        "tokenSize": round(TOKEN_MARKER_IN * dpi),
        "corners": {str(k): [round(v[0]), round(v[1])] for k, v in centers.items()},
        "tokens": {str(mid): dur for dur, ids in TOKEN_GROUPS for mid in ids},
    }
    (ROOT / "plan.json").write_text(json.dumps(meta, indent=1))
    print(f"plan_print: page {SHEET_IN[0]} x {SHEET_IN[1]} in at {dpi:.0f} dpi, plan + markers "
          f"{rotated.width / dpi:.1f} x {rotated.height / dpi:.1f} in, corner markers "
          f"{CORNER_SIZE / dpi:.2f} in, plan scale {dpi:.0f} px/in")


def build_tokens():
    dpi = TOKEN_DPI
    page = Image.new("L", (int(8.5 * dpi), int(11 * dpi)), 255)
    d = ImageDraw.Draw(page)
    cell = int((TOKEN_MARKER_IN + 0.45) * dpi)  # marker + white border + label
    mpx = int(TOKEN_MARKER_IN * dpi)
    cols = 4
    x0 = (page.width - cols * cell) // 2
    y0 = int(0.75 * dpi)
    d.text((x0, int(0.3 * dpi)), "Booking tokens  ·  DICT_4X4_50  ·  cut on dashed lines",
           fill=0, font=font(42))

    row = 0
    for dur, ids in TOKEN_GROUPS:
        ids = list(ids)
        for i, mid in enumerate(ids):
            c, r = i % cols, row + i // cols
            cx, cy = x0 + c * cell, y0 + r * cell
            page.paste(marker(mid, mpx), (cx + (cell - mpx) // 2, cy + int(0.1 * dpi)))
            d.text((cx + cell // 2, cy + cell - int(0.15 * dpi)), f"{dur} MIN  ·  #{mid}",
                   fill=0, font=font(34), anchor="mm")
            dashed_rect(d, cx, cy, cell)
        row += -(-len(ids) // cols)
    page.save(OUT / "tokens.png", dpi=(dpi, dpi))
    save_pdf(page, OUT / "tokens.pdf", dpi)


def build_corner_sheet():
    dpi = 300
    page = Image.new("L", (int(8.5 * dpi), int(11 * dpi)), 255)
    d = ImageDraw.Draw(page)
    mpx = int(2 * dpi)
    for i, (mid, where) in enumerate(CORNER_IDS.items()):
        cx = int(0.75 * dpi) + (i % 2) * int(3.75 * dpi)
        cy = int(0.9 * dpi) + (i // 2) * int(3.6 * dpi)
        page.paste(marker(mid, mpx), (cx, cy))
        d.text((cx, cy + mpx + 40), f"Corner #{mid}  ({where} of plan)", fill=0, font=font(44))
    d.text((int(0.75 * dpi), int(8.4 * dpi)),
           "Spares. plan_print already includes these in the right place.\n"
           "If you place them by hand, update the corner positions in plan.json.",
           fill=90, font=font(40))
    page.save(OUT / "corners.png", dpi=(dpi, dpi))
    save_pdf(page, OUT / "corners.pdf", dpi)


def dashed_rect(d, x, y, s, dash=18):
    for a in range(0, s, dash * 2):
        b = min(a + dash, s)
        d.line([x + a, y, x + b, y], fill=170, width=2)
        d.line([x + a, y + s, x + b, y + s], fill=170, width=2)
        d.line([x, y + a, x, y + b], fill=170, width=2)
        d.line([x + s, y + a, x + s, y + b], fill=170, width=2)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    build_plan()
    build_tokens()
    build_corner_sheet()
    print(f"wrote {OUT}/ and {ROOT / 'plan.json'}")
