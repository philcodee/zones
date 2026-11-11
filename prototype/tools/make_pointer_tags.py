"""
Generate the directional pointer tags for the zones prototype.

Pointer tags are normal DICT_4X4_50 markers, printed at the same 0.75 in size as the
zone tokens (225 px at 300 DPI). Unlike tokens, their rotation matters: the marker's
top edge is the pointer. Each card has an arrow above the top edge so people know which
way it points. The arrow sits outside the marker's white quiet zone so it can't be
mistaken for part of the tag.

Outputs:
  ../print/pointers.png / .pdf      letter sheet, 2 cards per pointer, with cut lines
  ../../aruco/aruco_4x4_50_id<N>.png  the bare marker, 225 px (0.75 in at 300 DPI)

Pointer IDs and names must match "pointers" in ../zones.json.

Usage:  python3 tools/make_pointer_tags.py
"""

import json
from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "print"
ARUCO_DIR = ROOT.parent / "aruco"
DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

DPI = 300
MARKER = 225                 # 0.75 in, same as the zone tokens
QUIET = 60                   # white margin around the marker (0.2 in, > 1 module of 37.5 px)
ARROW_H = 70
LABEL_H = 60
CARD_W = MARKER + 2 * QUIET
CARD_H = QUIET + ARROW_H + QUIET + MARKER + QUIET + LABEL_H
COPIES = 2
SHEET = (int(8.5 * DPI), int(11 * DPI))


def font(px):
    for name in ("/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            pass
    return ImageFont.load_default()


def marker(mid):
    return Image.fromarray(cv2.aruco.generateImageMarker(DICTIONARY, mid, MARKER)).convert("L")


def card(mid, name):
    img = Image.new("L", (CARD_W, CARD_H), 255)
    d = ImageDraw.Draw(img)
    # Arrow pointing at the top edge's direction, centred above the marker.
    cx, top = CARD_W // 2, QUIET
    d.polygon([(cx, top), (cx + ARROW_H * 0.6, top + ARROW_H), (cx - ARROW_H * 0.6, top + ARROW_H)], fill=0)
    my = QUIET + ARROW_H + QUIET
    img.paste(marker(mid), (QUIET, my))
    d.text((cx, my + MARKER + QUIET * 0.6), f"{name} · #{mid}", fill=0, font=font(30), anchor="mt")
    return img


def main():
    cfg = json.loads((ROOT / "zones.json").read_text())
    pointers = cfg["pointers"]
    OUT.mkdir(exist_ok=True)
    ARUCO_DIR.mkdir(exist_ok=True)

    sheet = Image.new("L", SHEET, 255)
    d = ImageDraw.Draw(sheet)
    gap = 90
    cards = [(int(mid), p["name"]) for mid, p in pointers.items() for _ in range(COPIES)]
    cols = 4
    x0 = (SHEET[0] - (cols * CARD_W + (cols - 1) * gap)) // 2
    y0 = 300
    for i, (mid, name) in enumerate(cards):
        x, y = x0 + (i % cols) * (CARD_W + gap), y0 + (i // cols) * (CARD_H + gap)
        sheet.paste(card(mid, name), (x, y))
        d.rectangle([x - 1, y - 1, x + CARD_W, y + CARD_H], outline=170, width=2)  # cut line
    d.text((SHEET[0] // 2, 150), "Pointer tags · 0.75 in · print at 100% / actual size · the arrow marks the pointing edge",
           fill=0, font=font(34), anchor="mm")

    sheet.save(OUT / "pointers.png", dpi=(DPI, DPI))
    sheet.convert("RGB").save(OUT / "pointers.pdf", "PDF", resolution=DPI)
    for mid in pointers:
        marker(int(mid)).save(ARUCO_DIR / f"aruco_4x4_50_id{mid}.png", dpi=(DPI, DPI))
    print(f"wrote {OUT / 'pointers.pdf'} and {len(pointers)} marker PNGs in {ARUCO_DIR}")


if __name__ == "__main__":
    main()
