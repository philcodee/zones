// Zone relations: in / out, next to a zone, adjacent to each other. No DOM; runs in Node.
// Input is just token positions in sheet pixels, so any source works (ArUco, color blobs, test drags).
// Output is a stable snapshot plus plain-sentence events, ready to be spoken later.
import { pointInPoly } from './core.js';

export function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Distance from a point to a polygon's outline (0 on the edge). */
export function distToPoly(p, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]));
  return d;
}

export function zoneAt(p, zones) {
  return zones.find((z) => pointInPoly(p, z.points))?.id ?? null;
}

export class RelationTracker {
  constructor(zones, opts = {}) {
    this.zones = zones;
    this.opts = { dpi: 300, nextToInches: 1, adjacentInches: 1.5, holdMs: 300, missingMs: 1000, hysteresis: 1.2, tokenNames: {}, ...opts };
    this.tokens = new Map(); // id -> { id, pt, firstSeen, lastSeen, present }
    this.facts = new Map();  // "zone:ID" | "near:ID:Z" | "adj:A|B" -> { value, cand, since }
  }

  name(id) { return this.opts.tokenNames[id] || `Token ${id}`; }
  zoneName(z) { return this.zones.find((k) => k.id === z)?.name ?? z; }
  zoneOf(id) { return this.facts.get(`zone:${id}`)?.value ?? null; }

  /** A value only changes after the new reading has held for holdMs. Returns {from,to} on change. */
  _deb(key, raw, now, initial) {
    let f = this.facts.get(key);
    if (!f) { f = { value: initial, cand: initial, since: now }; this.facts.set(key, f); }
    if (raw === f.value) { f.cand = raw; f.since = now; return null; }
    if (raw !== f.cand) { f.cand = raw; f.since = now; }
    if (now - f.since < this.opts.holdMs) return null;
    const from = f.value;
    f.value = raw; f.since = now;
    return { from, to: raw };
  }

  _rawNear(id, pt, z, now) {
    if (pointInPoly(pt, z.points)) return false;
    const on = this.facts.get(`near:${id}:${z.id}`)?.value;
    const lim = this.opts.nextToInches * this.opts.dpi * (on ? this.opts.hysteresis : 1);
    return distToPoly(pt, z.points) <= lim;
  }

  _where(id) {
    const z = this.zoneOf(id);
    return z ? `in ${this.zoneName(z)}` : 'outside the zones';
  }

  /** obs: [{ id, pt: [x, y] }] in sheet pixels. Returns events: [{ type, text, ids }]. */
  update(obs, now = Date.now()) {
    const events = [], o = this.opts;
    const emit = (type, text, ids) => events.push({ type, text, ids, at: now });
    const seen = new Map(obs.map((k) => [String(k.id), k.pt]));

    // Presence: a token must be seen for holdMs to count, and missing for missingMs to be removed.
    for (const [id, pt] of seen) {
      let t = this.tokens.get(id);
      if (!t) { t = { id, pt, firstSeen: now, lastSeen: now, present: false }; this.tokens.set(id, t); }
      t.pt = pt; t.lastSeen = now;
      if (!t.present && now - t.firstSeen >= o.holdMs) {
        t.present = true;
        const z = zoneAt(pt, this.zones);
        this.facts.set(`zone:${id}`, { value: z, cand: z, since: now });
        const near = [];
        for (const zz of this.zones) {
          const v = this._rawNear(id, pt, zz, now);
          this.facts.set(`near:${id}:${zz.id}`, { value: v, cand: v, since: now });
          if (v) near.push(zz.name);
        }
        emit('placed', `${this.name(id)} placed ${this._where(id)}${near.length ? `, next to ${near.join(' and ')}` : ''}`, [id]);
      }
    }
    for (const [id, t] of [...this.tokens]) {
      if (seen.has(id)) continue;
      if (!t.present) { if (now - t.lastSeen > o.holdMs) this.tokens.delete(id); continue; }
      if (now - t.lastSeen >= o.missingMs) {
        const z = this.zoneOf(id);
        emit('removed', `${this.name(id)} removed${z ? ` from ${this.zoneName(z)}` : ''}`, [id]);
        for (const k of [...this.facts.keys()]) {
          const [kind, rest] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
          const involved = kind === 'adj' ? rest.split('|').includes(id) : rest.split(':')[0] === id;
          if (involved) this.facts.delete(k);
        }
        this.tokens.delete(id);
      }
    }

    // Zone and next-to, for tokens seen this frame (a covered token keeps its last state).
    for (const [id, pt] of seen) {
      if (!this.tokens.get(id)?.present) continue;
      const c = this._deb(`zone:${id}`, zoneAt(pt, this.zones), now, null);
      if (c) {
        const text = c.from && c.to ? `moved from ${this.zoneName(c.from)} to ${this.zoneName(c.to)}`
          : c.to ? `entered ${this.zoneName(c.to)}` : `left ${this.zoneName(c.from)}`;
        emit(c.to ? 'enter' : 'leave', `${this.name(id)} ${text}`, [id]);
      }
      for (const z of this.zones) {
        const n = this._deb(`near:${id}:${z.id}`, this._rawNear(id, pt, z, now), now, false);
        if (n) emit(n.to ? 'near' : 'not-near', `${this.name(id)} is ${n.to ? 'next to' : 'no longer next to'} ${z.name}`, [id]);
      }
    }

    // Adjacency between every pair of placed tokens.
    const placed = [...this.tokens.values()].filter((t) => t.present).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j], key = `adj:${a.id}|${b.id}`;
      const on = this.facts.get(key)?.value;
      const lim = o.adjacentInches * o.dpi * (on ? o.hysteresis : 1);
      const c = this._deb(key, Math.hypot(a.pt[0] - b.pt[0], a.pt[1] - b.pt[1]) <= lim, now, false);
      if (!c) continue;
      if (c.to) {
        const za = this.zoneOf(a.id), zb = this.zoneOf(b.id);
        const ctx = za === zb ? ` ${this._where(a.id)}` : ` (${this.name(a.id)} ${this._where(a.id)}, ${this.name(b.id)} ${this._where(b.id)})`;
        emit('adjacent', `${this.name(a.id)} and ${this.name(b.id)} are next to each other${ctx}`, [a.id, b.id]);
      } else {
        emit('apart', `${this.name(a.id)} and ${this.name(b.id)} are no longer next to each other`, [a.id, b.id]);
      }
    }
    return events;
  }

  /** Current stable state of every placed token. */
  snapshot() {
    return [...this.tokens.values()].filter((t) => t.present).map((t) => ({
      id: t.id, name: this.name(t.id), pt: t.pt, zone: this.zoneOf(t.id),
      near: this.zones.filter((z) => this.facts.get(`near:${t.id}:${z.id}`)?.value).map((z) => z.id),
      adjacent: [...this.facts].filter(([k, f]) => f.value && k.startsWith('adj:') && k.slice(4).split('|').includes(t.id))
        .map(([k]) => k.slice(4).split('|').find((x) => x !== t.id)),
    }));
  }
}
