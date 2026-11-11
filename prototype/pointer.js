// Directional pointer tags: which target is a pointer aimed at, and how far away is it?
// No DOM; runs in Node. All positions are sheet pixels (300 DPI).
import { pointInPoly } from './core.js';

/**
 * Distance along the ray (o + t·d, |d| = 1) to the first edge of `poly` it crosses, or Infinity.
 * From outside that's where it enters; from inside (a wall around the pointer) it's where it hits the wall.
 */
function rayToEdge(o, d, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay;
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-9) continue; // parallel
    const qx = ax - o[0], qy = ay - o[1];
    const t = (qx * ey - qy * ex) / den, u = (qx * d[1] - qy * d[0]) / den;
    if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

/** Distance along the ray to a circle's edge, or Infinity. 0 if the ray starts inside it. */
function rayIntoCircle(o, d, c, r) {
  const fx = o[0] - c[0], fy = o[1] - c[1];
  const b = fx * d[0] + fy * d[1], k = fx * fx + fy * fy - r * r;
  if (k <= 0) return 0;
  const disc = b * b - k;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

/**
 * Cast a narrow cone from a pointer and return the nearest target it hits.
 *  origin   pointer centre; heading in radians (sheet axes, 0 = +x, -π/2 = up)
 *  targets  { zones: [{id, name, points}], walls: [{id, name, points}], tokens: [{id, name, pt}] }
 *  opts     { beamDeg (half-angle), rays, tokenR (target token radius), selfR (pointer half-size) }
 * Zone outlines stop the beam from both sides: from outside it enters the zone ('zone'); from
 * inside it hits the zone's own edge ('edge', named "the edge of Zone A"). Where two zones share an
 * edge, entering the neighbour wins the tie, so a pointer in A aimed at the shared edge reports B.
 * Walls are closed outlines (e.g. the outer wall) that the beam hits from either side.
 * Eggs are hidden outlines (easter eggs) hit from either side; standing inside one counts as a hit at 0,
 * and on a tie (an egg sharing an edge with the wall) the egg wins.
 * Returns { kind: 'egg'|'zone'|'edge'|'wall'|'token', id, name, dist (px, from the pointer's front edge), hit: [x, y], angle } or null.
 */
export function castBeam(origin, heading, targets, opts = {}) {
  const { beamDeg = 10, rays = 9, tokenR = 112, selfR = 112 } = opts;
  const eggs = targets.eggs || [];
  const inEgg = eggs.find((e) => pointInPoly(origin, e.points));
  if (inEgg) return { kind: 'egg', id: inEgg.id, name: inEgg.name, dist: 0, hit: [...origin], angle: heading };
  const zones = (targets.zones || []).map((z) => ({ z, inside: pointInPoly(origin, z.points) }));
  const walls = targets.walls || [];
  const tokens = targets.tokens || [];
  const half = (beamDeg * Math.PI) / 180;
  let best = null;
  for (let i = 0; i < rays; i++) {
    const a = heading + (rays === 1 ? 0 : -half + (2 * half * i) / (rays - 1));
    const d = [Math.cos(a), Math.sin(a)];
    const RANK = { egg: -1, zone: 0, token: 1, edge: 2, wall: 3 }; // on a tie: egg, then entering a zone, beats an edge or wall
    const consider = (kind, t, id, name) => {
      if (t === Infinity) return;
      const off = Math.abs(a - heading);
      const better = !best || t < best.t - 1 ||
        (Math.abs(t - best.t) <= 1 && (RANK[kind] < RANK[best.kind] || (RANK[kind] === RANK[best.kind] && off < best.off)));
      if (better) best = { kind, id, name, t, off, a };
    };
    for (const { z, inside } of zones) {
      consider(inside ? 'edge' : 'zone', rayToEdge(origin, d, z.points), z.id, inside ? `the edge of ${z.name}` : z.name);
    }
    for (const w of walls) consider('wall', rayToEdge(origin, d, w.points), w.id, w.name);
    for (const e of eggs) consider('egg', rayToEdge(origin, d, e.points), e.id, e.name);
    for (const k of tokens) consider('token', rayIntoCircle(origin, d, k.pt, tokenR), k.id, k.name);
  }
  if (!best) return null;
  return {
    kind: best.kind, id: best.id, name: best.name,
    dist: Math.max(0, best.t - selfR),
    hit: [origin[0] + Math.cos(best.a) * best.t, origin[1] + Math.sin(best.a) * best.t],
    angle: best.a,
  };
}

/** Click period for a target `distPx` away: fastMs at nearInches or closer, slowMs at farInches or more. */
export function clickIntervalMs(distPx, { dpi = 300, nearInches = 1, farInches = 16, fastMs = 125, slowMs = 1000 } = {}) {
  const inches = distPx / dpi;
  const f = Math.min(1, Math.max(0, (inches - nearInches) / Math.max(1e-6, farInches - nearInches)));
  return fastMs + (slowMs - fastMs) * f;
}

/**
 * Easter-egg pad loudness (0..1) for a pointer `distPx` from the egg: 1 when touching, 0 at `reachInches`
 * or further. `curve` sets how steep the swell is: 1 = even, higher = quiet until close, then a sharp rise.
 */
export function padGain(distPx, { dpi = 300, padReachInches = 12, padCurve = 2 } = {}) {
  const f = 1 - distPx / dpi / Math.max(1e-6, padReachInches);
  return f <= 0 ? 0 : Math.pow(f, padCurve);
}

/**
 * Smooths a pointer's position and heading so hand jitter doesn't make the clicks stutter.
 * Heading is smoothed as a unit vector, so wrapping past ±180° is handled.
 */
export class PointerSmoother {
  constructor(alpha = 0.35) { this.alpha = alpha; this.s = new Map(); }

  /** pt and top (the midpoint of the tag's top edge), in sheet px. Returns { pt, heading }. */
  update(id, pt, top, now) {
    const raw = [top[0] - pt[0], top[1] - pt[1]], L = Math.hypot(...raw) || 1;
    const u = [raw[0] / L, raw[1] / L];
    let s = this.s.get(id);
    if (!s || now - s.at > 1000) s = { pt: [...pt], u };
    else {
      const k = this.alpha;
      s = { pt: [s.pt[0] + (pt[0] - s.pt[0]) * k, s.pt[1] + (pt[1] - s.pt[1]) * k], u: [s.u[0] + (u[0] - s.u[0]) * k, s.u[1] + (u[1] - s.u[1]) * k] };
    }
    s.at = now;
    this.s.set(id, s);
    return { pt: s.pt, heading: Math.atan2(s.u[1], s.u[0]) };
  }
}
