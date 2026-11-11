# Webcam Floor Plan Prototype: Build Plan (v2)

A top-down webcam watches the printed 3rd floor plan on a table. Physical tokens placed on a room act as bookings. The system shows which rooms are booked and which are available.

*v2 updates the zones to match the actual floor plan (room numbers 300 to 322).*

---

## 1. Goal

Make room booking tangible. Placing a token on a room reserves it, and anyone can see the status of every room at a glance.

**Success looks like:**
- Placing a token on a room books it
- Every bookable room visibly shows "booked" or "available"
- It works with no laptop screen in view (feedback comes from a projector)

---

## 2. Zones Mapped to the Floor Plan

| Zone | Rooms on plan | Bookable? |
|---|---|---|
| Entry / exit | Elevator Lobby 300, Reception/Waiting 303, Coat 304, both stairwells and elevators | No |
| Admin | Office 309, Office 312, Server 317, Closet 302 | Offices: maybe. Others: no |
| Lounge | Lounge 305 (Gallery 301 is next to it) | Maybe |
| Food prep | Pantry 306 | No |
| Lecture and learning | Classroom 1 (307), Classroom 2 (308) | Yes |
| Breakout: individual | Phone Booth 316 | Yes |
| Breakout: semi-private | Video 310, Video 311, Video 314 | Yes |
| Breakout: group | **Not clear on the plan** (see Open Questions) | Yes |
| Open studio space | Studio 315 | Yes |
| Bio breaks | Women 312, Men 3121 | No |
| Not in scope | HVAC 318 and 319, Elec. 322, Corridor 313 | No |

*Assumptions are marked "maybe." Room numbers 312 (Women and Office) and 3121 (Men) look duplicated or mistyped on the plan, so the system will use its own internal IDs.*

---

## 3. How It Works (Concept)

1. **Floor plan** sits on the table under the camera.
2. **Corner markers** around the plan let the camera locate it.
3. **Booking tokens** (cards with markers) are placed on a room to book it.
4. **Duration** is set by a token or card (e.g. 30 / 60 / 90 min).
5. **System** detects which room each token is in, records the booking (room, start time, duration), and starts a timer.
6. **Feedback** shows green (available) or red (booked) on each room, plus time remaining.

---

## 4. Hardware

- Webcam on a mount or arm, pointing straight down
- Printed floor plan on matte paper, large format (see Plan Size below)
- Printed markers: 4 corner markers and several booking/duration tokens
- Laptop (for now)
- Projector (later phase)
- Even, diffuse lighting

---

## 5. Plan Size and Orientation

**The plan is portrait, but webcams are landscape (16:9).** A portrait plan would waste most of the frame.

- **Rotate the plan 90°** so it is landscape. It then fills far more of the camera view.
- **Print it large** (18x24 in or bigger if possible). Small rooms like the Video rooms and Phone Booth are tiny at letter size.
- **Use small tokens.** Register a token by its center point, so the card can overhang the room edge.
- **Print the plan in light gray** so markers and projected color stand out.
- Consider a 1080p or 4K webcam for detail on the small rooms.

---

## 6. Software Approach

**Recommended: browser-based**, since it matches your web skills and later becomes the projected display.

- Webcam via `getUserMedia`
- Marker detection via an ArUco library (js-aruco2 or OpenCV.js)
- Homography to map camera view to floor plan coordinates
- Rooms stored as polygons in floor plan coordinates (a JSON file)
- Bookings held in memory, saved to `localStorage`
- Canvas overlay draws status

*Alternative:* Python + OpenCV for detection. Same logic, different tooling.

**Marker generation:** a Python script (`generate_markers.py`) creates all printable ArUco markers. The browser detector must use the same dictionary (`DICT_4X4_50`).

---

## 7. Build Phases

### Phase 1: Floor plan and rooms
- Rotate and export the plan at print size
- Trace each bookable room as a polygon (trace over the plan in an SVG editor or Figma)
- Start with the 7 bookable rooms: 307, 308, 315, 316, 310, 311, 314
- Add the rest (offices, lounge) once the core works

### Phase 1b: Marker generator
- Write a small Python script (OpenCV) that generates the markers
- Use one dictionary everywhere: `DICT_4X4_50`
- Output 4 corner markers (IDs 0 to 3), about 1.5 to 2 in each
- Output booking tokens (IDs 10 and up), about 1 in each
- Output duration markers if separate cards are used
- Export a printable sheet: ID labels, white borders, cut lines
- Print a test sheet and confirm the camera can read it

### Phase 2: Camera setup
- Mount the webcam overhead
- Confirm the whole plan is in frame
- Lock exposure and focus if possible
- Add corner markers to the plan

### Phase 3: Calibration
- Detect the 4 corner markers
- Compute the homography
- Overlay room outlines on the live video to check alignment

### Phase 4: Token detection
- Print tokens and assign marker IDs
- Detect tokens and find which room each one is in
- Test stability (no flicker when a token sits still)

### Phase 5: Booking logic
- Token in room starts a booking: room, start time, duration
- Token removed ends or cancels it
- Timer expires the booking automatically
- Prevent double-booking of one room

### Phase 6: Feedback on laptop
- Color each room by status
- Show room name and number, time remaining, who booked
- Keep it readable from a distance

### Phase 7: Projector (no laptop in view)
- Project the feedback from near the camera position
- Align the projection to the floor plan (second calibration)
- Handle the feedback loop (see Risks)
- Run the page fullscreen on the projector display

### Phase 8: Test and refine
- Run through every scenario with a few people
- Note confusion points and adjust tokens and visuals

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Projected color confuses the camera | High contrast black and white markers; keep projected colors light; or briefly mask the projection during detection |
| Small rooms are hard to hit | Large print size; tokens registered by center point |
| Glare on paper | Matte paper, diffuse lighting |
| Camera shifts | Re-run calibration; fix mount firmly |
| Hand occludes tokens | Only register a token after it's stable for ~1 second |
| Studio and Lounge are large open areas | Treat each as one room for now; split later if needed |

---

## 9. Testing Checklist

- [ ] All room outlines align with the printed plan
- [ ] Each token is detected reliably, including in the smallest rooms
- [ ] Booking starts and ends correctly
- [ ] Double booking is blocked
- [ ] Status is accurate within about 1 second
- [ ] Works under typical room lighting
- [ ] Readable from the projected view alone

---

## 10. Open Questions

1. **Which room is the "group" breakout?** The plan has no obvious one. Options: Gallery 301, a split of Classroom 2, or part of the Studio.
2. Are Offices 309 and 312 bookable, or admin only?
3. Is the Lounge bookable as a whole, or is it always open?
4. How should duration be set: separate cards, or one token per duration?
5. Should bookings show who reserved (name card) or just the purpose?
6. What print size and camera height are realistic?
7. Is a projector available, and where will it sit?

---

## 11. Suggested First Step

Do Phases 1 to 3 first (including 1b): generate and print the markers and the rotated plan, mount the camera, and get room outlines to line up on the live video. Everything else builds on that.
