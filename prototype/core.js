// Pure logic: geometry + booking rules. No DOM, so it runs in Node for tests.

// ---------- linear algebra ----------

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

// Hartley normalisation keeps the solve well conditioned for pixel-sized numbers.
function normaliser(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
  const s = Math.SQRT2 / d;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Least-squares homography from >= 4 point pairs. Returns row-major 3x3 or null. */
export function homography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) return null;
  const T1 = normaliser(src), T2 = normaliser(dst);
  const s = src.map((p) => applyH(T1, p)), d = dst.map((p) => applyH(T2, p));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k], [u, v] = d[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const T2inv = invert3(T2);
  const H = mul3(mul3(T2inv, [...h, 1]), T1);
  return H.map((v) => v / H[8]);
}

export function applyH(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** CSS matrix3d that maps an element's (0,0)-(w,h) box onto four screen points. */
export function cornerPinMatrix(w, h, pins) {
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], pins);
  if (!H) return 'none';
  const m = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, H[8]];
  return `matrix3d(${m.join(',')})`;
}

// ---------- geometry ----------

export function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function roomAt(pt, rooms) {
  // Smallest room wins, so a room drawn inside a bigger one still registers.
  let best = null, bestArea = Infinity;
  for (const r of rooms) {
    if (!pointInPoly(pt, r.points)) continue;
    const a = polyArea(r.points);
    if (a < bestArea) { best = r; bestArea = a; }
  }
  return best;
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

export function centroid(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function isBookable(room, includeMaybe) {
  return room.bookable === true || (includeMaybe && room.bookable === 'maybe');
}

// ---------- booking rules ----------

/**
 * Turns a stream of "token X is at room Y" observations into bookings.
 *  - a token must sit still in one room for `stableMs` before it counts
 *  - a token missing for `lostMs` is treated as lifted, ending its booking
 *  - one booking per room; a second token on a booked room is blocked
 *  - bookings expire on their own; the token is then "spent" until lifted
 */
export class BookingEngine {
  constructor({ rooms, durations, stableMs = 1000, lostMs = 1500, includeMaybe = false }) {
    this.rooms = new Map(rooms.map((r) => [r.id, r]));
    this.durations = durations; // tokenId -> minutes
    this.stableMs = stableMs;
    this.lostMs = lostMs;
    this.includeMaybe = includeMaybe;
    this.tokens = new Map();   // tokenId -> state
    this.bookings = new Map(); // roomId -> booking
  }

  setRooms(rooms) {
    this.rooms = new Map(rooms.map((r) => [r.id, r]));
  }

  /**
   * observations: [{ id, room: roomId|null, pt: [x,y] }] — every token seen this frame,
   * or null when there is no sensor data (camera off / not calibrated). A null tick only
   * expires bookings; it never treats tokens as lifted.
   */
  update(observations, now) {
    const events = [];
    const seen = new Set();
    if (!observations) {
      this.#expire(now, events);
      return events;
    }

    for (const o of observations) {
      if (!(o.id in this.durations)) continue;
      seen.add(o.id);
      let t = this.tokens.get(o.id);
      if (!t) {
        t = { id: o.id, room: undefined, candidate: o.room, since: now, spent: false };
        this.tokens.set(o.id, t);
      }
      t.lastSeen = now;
      t.pt = o.pt;
      if (o.room !== t.candidate) {
        t.candidate = o.room;
        t.since = now;
      }
      if (t.candidate !== t.room && now - t.since >= this.stableMs) {
        this.#release(t, now, events);
        t.room = t.candidate;
        t.spent = false;
        t.blocked = false;
      }
    }

    for (const t of [...this.tokens.values()]) {
      if (seen.has(t.id)) continue;
      if (now - t.lastSeen > this.lostMs) {
        this.#release(t, now, events);
        this.tokens.delete(t.id);
      }
    }

    this.#expire(now, events);

    for (const t of this.tokens.values()) {
      if (t.room && !t.spent && t.candidate === t.room) this.#tryBook(t, now, events);
    }
    return events;
  }

  #expire(now, events) {
    for (const b of [...this.bookings.values()]) {
      if (now >= b.end) {
        this.bookings.delete(b.roomId);
        const t = this.tokens.get(b.tokenId);
        if (t) t.spent = true;
        events.push({ type: 'expired', roomId: b.roomId, tokenId: b.tokenId, at: now });
      }
    }
  }

  #tryBook(t, now, events) {
    const room = this.rooms.get(t.room);
    const held = this.bookings.get(t.room);
    if (held?.tokenId === t.id) return;
    if (!room || !isBookable(room, this.includeMaybe)) {
      if (t.blocked !== 'not-bookable') events.push({ type: 'not-bookable', roomId: t.room, tokenId: t.id, at: now });
      t.blocked = 'not-bookable';
      return;
    }
    if (held) {
      if (t.blocked !== 'conflict') events.push({ type: 'conflict', roomId: t.room, tokenId: t.id, at: now });
      t.blocked = 'conflict';
      return;
    }
    const minutes = this.durations[t.id];
    this.bookings.set(t.room, { roomId: t.room, tokenId: t.id, minutes, start: now, end: now + minutes * 60000 });
    t.blocked = false;
    events.push({ type: 'booked', roomId: t.room, tokenId: t.id, minutes, at: now });
  }

  #release(t, now, events) {
    const b = t.room && this.bookings.get(t.room);
    if (b && b.tokenId === t.id) {
      this.bookings.delete(t.room);
      events.push({ type: 'ended', roomId: t.room, tokenId: t.id, at: now });
    }
  }

  /** Manual cancel from the UI. The token stays "spent" until it is lifted. */
  cancel(roomId, now) {
    const b = this.bookings.get(roomId);
    if (!b) return [];
    this.bookings.delete(roomId);
    const t = this.tokens.get(b.tokenId);
    if (t) t.spent = true;
    return [{ type: 'cancelled', roomId, tokenId: b.tokenId, at: now }];
  }

  /** Restore saved bookings; their tokens get `graceMs` to be seen again. */
  restore(bookings, now, graceMs = 5000) {
    for (const b of bookings) {
      if (b.end <= now || !this.rooms.has(b.roomId)) continue;
      this.bookings.set(b.roomId, b);
      this.tokens.set(b.tokenId, {
        id: b.tokenId, room: b.roomId, candidate: b.roomId, since: now,
        lastSeen: now + graceMs - this.lostMs, spent: false, blocked: false,
      });
    }
  }

  /** Per-room status for rendering. */
  status(roomId, now) {
    const room = this.rooms.get(roomId);
    const b = this.bookings.get(roomId);
    if (b) return { state: 'booked', booking: b, remainingMs: Math.max(0, b.end - now) };
    if (!room || !isBookable(room, this.includeMaybe)) return { state: 'inactive' };
    return { state: 'available' };
  }
}
