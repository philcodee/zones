# Zones — Prototype

A webcam over an 11 × 17 printed sheet. ArUco tokens placed on the sheet are tracked in and out of
zones, next to zones, and next to each other, with spoken and tonal feedback. Pointer tags add
sonar-style clicks that show what they're aimed at.

The earlier room-booking app is in `../archive/room-booking/`.

## Run it

```sh
cd prototype
python3 -m http.server 8000
```

Open http://localhost:8000/zones.html. The camera only works over `localhost` or HTTPS.
Without a camera, use **Add test token** and **Add test pointer** on the sheet map.

`calibrate.html` is a bench for checking corner-tag detection on the sheet.

## Mixer and defaults

The **Mixer** panel sets the levels for master, speech, tones and pointer ticks. Each has a ▶ button to preview it.
Changes are remembered in this browser only. To make the current settings (the mixer plus the **Rules**
settings) the defaults, click **Copy JSON** and paste it over all of `zones.json`. In Chrome or Edge you can also use
**Save to zones.json…** and pick this folder's `zones.json`. **Reset to defaults** clears this browser's changes.

## Tags

All tags use `DICT_4X4_50`. The browser uses js-aruco2's `ARUCO_4X4_1000`, whose first 50 codes match.

| IDs | What | Size |
|---|---|---|
| 0–3 | Sheet corners (`../aruco/`) | 1 in |
| 40, 41 | Pointer tags: the top edge points | 0.75 in |
| any other | Tokens | 0.75 in |

Print the pointer tags with `python3 tools/make_pointer_tags.py`. It writes `print/pointers.pdf`,
which should be printed on Letter paper at 100% / actual size. It also writes the bare markers to `../aruco/`.
The arrow on each card marks the pointing edge. Cut along the grey line and keep the white margin.

## Pointer clicks

A pointer casts a narrow beam from its top edge. The beam stops at the first zone edge or outer wall it meets, and the pointer ticks:

- **1″ or closer:** 8 ticks per second. **16″ or more:** 1 per second. The rate scales evenly in between.
- **Targets:** the two zones and the outer wall only. Tokens and interior walls aren't targets. Inside the walls there's always something in the beam, so a pointer that's on the sheet always ticks.
- **Zone edges stop the beam from both sides.** From inside Zone A, aiming at its outer edges reports "the edge of Zone A". Aiming at the edge A shares with B reports "Zone B".
- **Distance:** measured from the pointer's front edge to where the beam first meets the target.
- **Tone:** each pointer's tick has its own tone, so two at once can be told apart.
- **Status:** press **S** to hear what each pointer is aimed at.

The outer wall is a polygon under `walls` in `zones.json`. It was traced from `studio map outline-2 11x17.jpg`
along the inside face of the wall, and it's drawn dashed yellow on the sheet map. Spatial Pixel Lab is outside it.
**Easter egg:** when a pointer's beam lands on Spatial Pixel Lab, or the pointer sits inside it, its ticks stop and a warm
pad plays instead. Its loudness follows distance: silent at **Easter egg reach** (further away, the lab ticks like the
wall), full when touching, and **Easter egg swell steepness** sets the curve, `(1 − distance ÷ reach) ^ steepness`.
Both are in Rules and saved by Copy JSON (`sonar.padReachInches`, `sonar.padCurve`). It fades out when the pointer moves off. The lab's outline is under `easterEggs` in `zones.json` and isn't
drawn on the map. Its level is the **Easter egg** slider in the Mixer (`mix.pad`).

Pointer names and tick tones (`pitch` = the centre of the tick's filter, in Hz) are under `pointers`. Default ranges are under `sonar`.
You can also change the beam width and the distances under **Rules** on the page.
The beam logic is in `pointer.js`, which has no DOM code and runs in Node.
