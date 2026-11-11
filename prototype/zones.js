// Zone relations page: camera tokens (and draggable test tokens) -> in / out / next to / adjacent.
import { applyH } from './core.js';
import { SheetCam, SHEET, CORNER_IDS } from './sheetcam.js';
import { RelationTracker } from './zonecore.js';
import { Speaker, Sonar } from './audio.js';
import { castBeam, clickIntervalMs, padGain, PointerSmoother } from './pointer.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const TOKEN_R = 112; // 0.75" token, in sheet px

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('zones.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('zones.' + k, JSON.stringify(v)); } catch {} },
};

const cfg = await (await fetch('zones.json', { cache: 'no-cache' })).json();
const zones = cfg.zones;
const walls = cfg.walls || [];        // closed outlines the pointer beam stops at (the outer wall)
const eggs = cfg.easterEggs || [];    // hidden outlines: a pointer on one plays the warm pad instead of ticking
const pointerCfg = cfg.pointers || {}; // tag id -> { name, pitch }
const sonarOpts = {
  dpi: cfg.sheet.dpi, ...cfg.sonar,
  beamDeg: store.get('beamDeg', cfg.sonar?.beamDeg ?? 10),
  nearInches: store.get('nearInches', cfg.sonar?.nearInches ?? 1),
  farInches: store.get('farInches', cfg.sonar?.farInches ?? 16),
  fastMs: store.get('fastMs', cfg.sonar?.fastMs ?? 125),   // tick period at nearInches or closer
  slowMs: store.get('slowMs', cfg.sonar?.slowMs ?? 1000),  // tick period at farInches or further
  padReachInches: store.get('padReachInches', cfg.sonar?.padReachInches ?? 12), // easter-egg pad starts this close
  padCurve: store.get('padCurve', cfg.sonar?.padCurve ?? 2),                    // how steeply it swells
};
// Which edge of each pointer tag does the pointing: 0 = printed top, 90 = right, 180 = bottom, 270 = left.
// Lets a tag be stuck onto a block in any orientation. zones.json default, then this browser's choice.
const pointerOffsets = { ...Object.fromEntries(Object.entries(pointerCfg).map(([id, p]) => [id, p.offsetDeg ?? 0])), ...store.get('pointerOffsets', {}) };
const pointerNames = Object.fromEntries(Object.entries(pointerCfg).map(([id, p]) => [id, p.name]));
const tracker = new RelationTracker(zones, {
  dpi: cfg.sheet.dpi, holdMs: cfg.holdMs, missingMs: cfg.missingMs, tokenNames: { ...pointerNames, ...cfg.tokenNames },
  nextToInches: store.get('nextTo', cfg.nextToInches), adjacentInches: store.get('adjacent', cfg.adjacentInches),
});
const zoneById = Object.fromEntries(zones.map((z) => [z.id, z]));

// ---------- state ----------
const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const cam = new SheetCam(video, onCameraFrame);
let camTokens = [], testTokens = store.get('tests', []), testSeq = store.get('testSeq', 0);
let rotation = store.get('rotation', null); // null = match the camera once calibrated
for (const t of testTokens) tracker.opts.tokenNames[t.id] = t.name;

// ---------- feeding the tracker ----------
function observe() {
  const obs = [...camTokens.map((t) => ({ id: String(t.id), pt: t.pt })), ...testTokens.map((t) => ({ id: t.id, pt: t.pt }))];
  const now = Date.now();
  const events = tracker.update(obs, now);
  for (const ev of events) logEvent(ev);
  speaker.announce(events);
  updatePointers(now);
  renderMap();
  renderNow();
}

// ---------- pointers (directional tags -> sonar clicks) ----------
const smoother = new PointerSmoother();
const POINTER_GRACE_MS = 400; // keep clicking through a brief missed detection
let aims = new Map();         // id -> { id, name, pt, heading, pitch, hit, at }

function updatePointers(now) {
  const live = [];
  for (const t of camTokens) {
    const p = pointerCfg[t.id];
    if (!p || !t.top) continue;
    const s = smoother.update(String(t.id), t.pt, t.top, now);
    // Sheet y points down, so adding degrees turns clockwise: top -> right -> bottom -> left.
    live.push({ id: String(t.id), name: p.name, pitch: p.pitch, pt: s.pt, heading: s.heading + ((pointerOffsets[t.id] || 0) * Math.PI) / 180 });
  }
  for (const t of testTokens) if (t.pointer) live.push({ id: t.id, name: t.name, pitch: t.pitch, pt: t.pt, heading: t.heading });

  // Targets: the two zones and the outer wall. Tokens are deliberately not targets.
  const next = new Map();
  for (const p of live) {
    const hit = castBeam(p.pt, p.heading, { zones, walls, eggs }, { beamDeg: sonarOpts.beamDeg, selfR: TOKEN_R });
    next.set(p.id, { ...p, hit, at: now });
  }
  for (const [id, a] of aims) if (!next.has(id) && !id.startsWith('P') && now - a.at < POINTER_GRACE_MS) next.set(id, a);
  for (const id of aims.keys()) if (!next.has(id)) sonar.set(id, null);
  for (const a of next.values()) {
    const h = a.hit, g = h?.kind === 'egg' ? padGain(h.dist, sonarOpts) : 0;
    // On the egg and within reach: pad, louder as it gets closer. Out of reach, the egg ticks like a wall.
    sonar.set(a.id, !h ? null : g > 0 ? { pad: true, gain: g } : { intervalMs: clickIntervalMs(h.dist, sonarOpts), pitch: a.pitch });
  }
  aims = next;
}
const aimText = (a) => (a.hit ? `pointing at ${a.hit.name}, ${(a.hit.dist / cfg.sheet.dpi).toFixed(1)}″ away` : 'pointing at nothing');
setInterval(() => { if (!cam.stream) observe(); }, 50); // camera frames drive it while the camera runs

function onCameraFrame({ tokens, fit }) {
  camTokens = tokens;
  if (fit && rotation == null) matchCameraRotation(fit);
  observe();
  drawOverlay(fit);
  const dots = CORNER_IDS.map((id) => (cam.anchors[id] ? '●' : '○')).join('');
  $('#status').textContent = `Corners ${dots} ${fit ? 'calibrated' : 'finding corners'} · ${tokens.length} token${tokens.length === 1 ? '' : 's'} · ${cam.fps.toFixed(0)} fps · detect ${Math.round(cam.scale * 100)}%`;
}

// ---------- camera ----------
async function listCameras() {
  const devs = await SheetCam.cameras(), sel = $('#camSelect'), want = store.get('cam', null);
  sel.replaceChildren(...devs.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (want && devs.some((d) => d.deviceId === want)) sel.value = want;
}
async function startCam() {
  try {
    const id = await cam.start($('#camSelect').value || store.get('cam', null));
    store.set('cam', id);
    await listCameras();
  } catch (e) { $('#status').textContent = `Camera error: ${e.message}`; return; }
  $('#stage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  $('#empty').hidden = true;
  $('#start').textContent = 'Stop camera';
}
function stopCam() {
  cam.stop(); camTokens = [];
  octx.clearRect(0, 0, overlay.width, overlay.height);
  $('#start').textContent = 'Start camera';
  $('#status').textContent = 'Camera off';
}

function drawOverlay(fit) {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  if (!fit) return;
  const lw = Math.max(2, w / 640), P = (p) => applyH(fit.toCam, p);
  const path = (pts) => { octx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? octx.lineTo(x, y) : octx.moveTo(x, y); }); octx.closePath(); };
  for (const z of zones) {
    path(z.points);
    octx.fillStyle = z.color + '33'; octx.fill();
    octx.lineWidth = lw * 1.5; octx.strokeStyle = z.color; octx.stroke();
    const c = z.points.reduce((a, p) => [a[0] + p[0] / z.points.length, a[1] + p[1] / z.points.length], [0, 0]);
    const [cx, cy] = P(c);
    octx.font = `700 ${lw * 14}px ui-monospace, "SF Mono", Menlo, monospace`; octx.fillStyle = z.color; octx.textAlign = 'center';
    octx.fillText(z.name, cx, cy);
  }
  const snap = Object.fromEntries(tracker.snapshot().map((s) => [s.id, s]));
  octx.textAlign = 'left';
  for (const t of camTokens) {
    const s = snap[String(t.id)], col = s?.zone ? zoneById[s.zone].color : '#ffffff';
    const m = cam.markers.find((k) => k.id === t.id);
    if (m) {
      octx.beginPath(); m.corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y))); octx.closePath();
      octx.lineWidth = lw * 2; octx.strokeStyle = col; octx.stroke();
    }
    octx.font = `600 ${lw * 9}px ui-monospace, "SF Mono", Menlo, monospace`; octx.fillStyle = col;
    octx.fillText(`${tracker.name(String(t.id))}${s ? ' · ' + (s.zone ? zoneById[s.zone].name : 'out') : ''}`, t.cam[0] + lw * 12, t.cam[1]);
  }
  // Pointer beams, drawn in sheet space and mapped into the camera image.
  for (const a of aims.values()) {
    if (a.id.startsWith('P')) continue; // test pointers only exist on the sheet map
    const end = a.hit ? a.hit.hit : [a.pt[0] + Math.cos(a.heading) * 1500, a.pt[1] + Math.sin(a.heading) * 1500];
    const [x1, y1] = P(a.pt), [x2, y2] = P(end);
    octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2);
    octx.setLineDash(a.hit ? [] : [lw * 4, lw * 4]); octx.lineWidth = lw * 2; octx.strokeStyle = a.hit ? '#ffd23f' : '#ffffff88'; octx.stroke();
    octx.setLineDash([]);
    if (a.hit) { octx.beginPath(); octx.arc(x2, y2, lw * 4, 0, Math.PI * 2); octx.fillStyle = '#ffd23f'; octx.fill(); }
  }
}

// ---------- sheet map ----------
const svg = $('#map'), rot = $('#rot');
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}
function applyRotation() {
  const r = ((rotation ?? 0) % 360 + 360) % 360, W = SHEET.w, H = SHEET.h;
  svg.setAttribute('viewBox', r % 180 ? `0 0 ${H} ${W}` : `0 0 ${W} ${H}`);
  const t = { 0: '', 90: `translate(${H},0) rotate(90)`, 180: `translate(${W},${H}) rotate(180)`, 270: `translate(0,${W}) rotate(270)` }[r];
  rot.setAttribute('transform', t);
}
function matchCameraRotation(fit) {
  // Which way does the sheet's x axis point in the camera image? Turn the map the same way.
  const a = applyH(fit.toCam, [0, 0]), b = applyH(fit.toCam, [1000, 0]);
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  rotation = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  applyRotation();
}
const base = el('g', {}, rot), live = el('g', {}, rot);
el('image', { href: cfg.sheet.image, x: 0, y: 0, width: SHEET.w, height: SHEET.h, opacity: 0.5 }, base);
for (const z of zones) {
  el('polygon', { class: 'zone', points: z.points.map((p) => p.join(',')).join(' '), fill: z.color, stroke: z.color }, base);
  const c = z.points.reduce((a, p) => [a[0] + p[0] / z.points.length, a[1] + p[1] / z.points.length], [0, 0]);
  el('text', { class: 'zlabel', x: c[0], y: c[1], fill: z.color }, base).textContent = z.name;
}
for (const w of walls) el('polygon', { class: 'wall', points: w.points.map((p) => p.join(',')).join(' ') }, base);
applyRotation();

function renderMap() {
  live.replaceChildren();
  const snap = tracker.snapshot(), byId = Object.fromEntries(snap.map((s) => [s.id, s]));
  for (const s of snap) for (const o of s.adjacent) if (s.id < o && byId[o]) el('line', { class: 'adj', x1: s.pt[0], y1: s.pt[1], x2: byId[o].pt[0], y2: byId[o].pt[1] }, live);
  for (const a of aims.values()) {
    const end = a.hit ? a.hit.hit : [a.pt[0] + Math.cos(a.heading) * 1500, a.pt[1] + Math.sin(a.heading) * 1500];
    el('line', { class: `beam${a.hit ? ' on' : ''}`, x1: a.pt[0], y1: a.pt[1], x2: end[0], y2: end[1] }, live);
    if (a.hit) el('circle', { class: 'beamhit', cx: end[0], cy: end[1], r: 40 }, live);
  }
  const shown = [...testTokens.map((t) => ({ id: t.id, pt: t.pt, test: true })), ...camTokens.map((t) => ({ id: String(t.id), pt: t.pt }))];
  // Covered tokens the tracker still remembers: draw them faded at their last position.
  const visible = new Set(shown.map((t) => t.id));
  for (const s of snap) if (!visible.has(s.id)) shown.push({ id: s.id, pt: s.pt, hidden: true });
  for (const t of shown) {
    const s = byId[t.id], g = el('g', { class: `tok${t.test ? ' test' : ''}`, 'data-id': t.id, opacity: t.hidden ? 0.35 : 1 }, live);
    for (const [i, zid] of (s?.near || []).entries()) el('circle', { class: 'ring', cx: t.pt[0], cy: t.pt[1], r: TOKEN_R + 40 + i * 30, stroke: zoneById[zid].color }, g);
    el('circle', { class: 'body', cx: t.pt[0], cy: t.pt[1], r: TOKEN_R, fill: s?.zone ? zoneById[s.zone].color : s ? '#555' : '#aaa' }, g);
    const a = aims.get(t.id);
    if (a) { // pointer: a triangle on the pointing edge
      const tip = (r, da) => [t.pt[0] + Math.cos(a.heading + da) * r, t.pt[1] + Math.sin(a.heading + da) * r];
      el('polygon', { class: 'nose', points: [tip(TOKEN_R + 70, 0), tip(TOKEN_R, 0.45), tip(TOKEN_R, -0.45)].map((p) => p.join(',')).join(' ') }, g);
    }
    const label = el('text', { x: t.pt[0], y: t.pt[1] }, g);
    label.textContent = t.test ? t.id : t.id;
    // keep labels upright when the map is rotated
    if (rotation) label.setAttribute('transform', `rotate(${-rotation} ${t.pt[0]} ${t.pt[1]})`);
  }
}

// Drag test tokens. Test pointers also turn: mouse wheel over one, or [ and ] for the last one touched.
let drag = null, lastPointer = null;
function turnTestPointer(t, deg) {
  t.heading += (deg * Math.PI) / 180;
  store.set('tests', testTokens);
  if (cam.stream) observe(); // without the camera, the 50 ms loop picks it up
}
svg.addEventListener('wheel', (e) => {
  const t = testTokens.find((k) => k.id === e.target.closest('.tok.test')?.dataset.id);
  if (!t?.pointer) return;
  e.preventDefault();
  lastPointer = t;
  turnTestPointer(t, Math.sign(e.deltaY) * 10);
}, { passive: false });
const toSheet = (e) => { const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(rot.getScreenCTM().inverse()); return [p.x, p.y]; };
svg.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('.tok.test');
  if (!g) return;
  drag = testTokens.find((t) => t.id === g.dataset.id);
  if (drag?.pointer) lastPointer = drag;
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', (e) => { if (drag) { drag.pt = toSheet(e); renderMap(); } });
svg.addEventListener('pointerup', () => {
  if (!drag) return;
  const [x, y] = drag.pt;
  if (x < 0 || y < 0 || x > SHEET.w || y > SHEET.h) testTokens = testTokens.filter((t) => t !== drag);
  drag = null;
  store.set('tests', testTokens);
});
$('#addTest').onclick = () => {
  testSeq++;
  const id = `T${testSeq}`;
  testTokens.push({ id, name: `Test ${testSeq}`, pt: [2600, 1000 + ((testSeq - 1) % 8) * 300] });
  tracker.opts.tokenNames[id] = `Test ${testSeq}`;
  store.set('tests', testTokens); store.set('testSeq', testSeq);
};
$('#addPointer').onclick = () => {
  testSeq++;
  const n = testTokens.filter((t) => t.pointer).length + 1, kinds = Object.values(pointerCfg);
  const id = `P${testSeq}`, name = `Test pointer ${n}`;
  testTokens.push({ id, name, pt: [700, 1000 + ((n - 1) % 8) * 300], pointer: true, heading: 0, pitch: kinds[(n - 1) % kinds.length]?.pitch ?? 3000 });
  tracker.opts.tokenNames[id] = name;
  lastPointer = testTokens.at(-1);
  store.set('tests', testTokens); store.set('testSeq', testSeq);
};
$('#clearTest').onclick = () => { testTokens = []; lastPointer = null; store.set('tests', testTokens); };

// ---------- panels ----------
const pill = (z) => `<span class="pill" style="background:${zoneById[z].color}">${zoneById[z].name}</span>`;
function renderNow() {
  const snap = tracker.snapshot();
  $('#zonesNow').innerHTML = [
    ...zones.map((z) => {
      const inZ = snap.filter((s) => s.zone === z.id);
      return `<li>${pill(z.id)} ${inZ.length ? inZ.map((s) => `<b>${s.name}</b>`).join(', ') : '<span class="muted">empty</span>'}</li>`;
    }),
    `<li><span class="pill" style="background:#555">Outside</span> ${snap.filter((s) => !s.zone).map((s) => `<b>${s.name}</b>`).join(', ') || '<span class="muted">none</span>'}</li>`,
  ].join('');
  $('#now').innerHTML = snap.length ? snap.map((s) => {
    const bits = [s.zone ? `in ${zoneById[s.zone].name}` : 'outside the zones'];
    if (s.near.length) bits.push(`next to ${s.near.map((z) => zoneById[z].name).join(' and ')}`);
    if (s.adjacent.length) bits.push(`next to ${s.adjacent.map((o) => tracker.name(o)).join(', ')}`);
    if (aims.has(s.id)) bits.push(aimText(aims.get(s.id)));
    return `<li><b>${s.name}</b>: ${bits.join(' · ')}</li>`;
  }).join('') : '<li class="muted">No tokens placed</li>';
}

function logEvent(ev) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${new Date(ev.at).toLocaleTimeString()}</time>`;
  li.append(ev.text);
  const log = $('#log');
  log.prepend(li);
  while (log.children.length > 100) log.lastChild.remove();
}

// ---------- audio ----------
const speaker = new Speaker(store.get('audio', {}));
const sonar = new Sonar(speaker);
sonar.enabled = store.get('sonarOn', true);
speaker.setMix({ ...cfg.mix, ...store.get('mix', {}) }); // zones.json defaults, then this browser's tweaks
const saveAudio = () => store.set('audio', { speech: speaker.speech, tones: speaker.tones, rate: speaker.rate, voiceURI: speaker.voiceURI });
const nameList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function statusSentence() {
  const snap = tracker.snapshot();
  if (!snap.length) return 'No tokens on the map.';
  const parts = zones.map((z) => {
    const inZ = snap.filter((s) => s.zone === z.id).map((s) => s.name);
    return `${z.name}: ${inZ.length ? nameList(inZ) : 'empty'}.`;
  });
  const out = snap.filter((s) => !s.zone).map((s) => s.name);
  if (out.length) parts.push(`Outside: ${nameList(out)}.`);
  const pairs = [];
  for (const s of snap) for (const o of s.adjacent) if (s.id < o) pairs.push(`${s.name} and ${tracker.name(o)}`);
  if (pairs.length) parts.push(`Next to each other: ${pairs.join('; ')}.`);
  for (const a of aims.values()) {
    parts.push(a.hit ? `${a.name} is pointing at ${a.hit.name}, about ${Math.max(1, Math.round(a.hit.dist / cfg.sheet.dpi))} inches away.` : `${a.name} is pointing at nothing.`);
  }
  return parts.join(' ');
}

function bindAudio() {
  const sp = $('#speech'), tn = $('#tones'), rate = $('#rate'), voice = $('#voice');
  speaker.onSay = (text) => { $('#lastSaid').textContent = `Said: ${text}`; };  if (!speaker.supported.speech) { sp.disabled = true; sp.parentElement.title = 'This browser has no speech'; }
  sp.checked = speaker.speech; tn.checked = speaker.tones; rate.value = speaker.rate; $('#rateOut').value = `${speaker.rate}×`;
  sp.onchange = () => { speaker.speech = sp.checked; if (!sp.checked) speaker.stop(); saveAudio(); };
  tn.onchange = () => { speaker.tones = tn.checked; saveAudio(); };
  const so = $('#sonarOn');
  so.checked = sonar.enabled;
  so.onchange = () => { sonar.enabled = so.checked; store.set('sonarOn', so.checked); };
  rate.oninput = () => { speaker.rate = Number(rate.value); $('#rateOut').value = `${rate.value}×`; saveAudio(); };
  const fillVoices = () => {
    const vs = speaker.voices();
    voice.replaceChildren(new Option('Default voice', ''), ...vs.map((v) => new Option(`${v.name} (${v.lang})`, v.voiceURI)));
    voice.value = vs.some((v) => v.voiceURI === speaker.voiceURI) ? speaker.voiceURI : '';
  };
  fillVoices();
  if (speaker.synth) speaker.synth.onvoiceschanged = fillVoices; // voices load late in Chrome
  voice.onchange = () => { speaker.voiceURI = voice.value || null; saveAudio(); };
  $('#sayStatus').onclick = () => { speaker.unlock(); speaker.tone('placed'); speaker.say(statusSentence(), { interrupt: true }); };
  $('#testSound').onclick = () => {
    speaker.unlock();
    speaker.tone('enter');
    speaker.say(`Audio is on. ${zones.map((z) => z.name).join(' and ')} are ready.`, { interrupt: true });
  };
}
// Sound is only allowed after the user interacts with the page.
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => speaker.unlock(), { capture: true });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 's' || e.key === 'S') { speaker.say(statusSentence(), { interrupt: true }); e.preventDefault(); }
  if (e.key === 'q' || e.key === 'Q') speaker.stop();
  if ((e.key === '[' || e.key === ']') && lastPointer && testTokens.includes(lastPointer)) { turnTestPointer(lastPointer, e.key === ']' ? 15 : -15); e.preventDefault(); }
});
bindAudio();

// ---------- settings ----------
function bindRange(id, key, optKey) {
  const r = $('#' + id), out = $('#' + id + 'Out');
  r.value = tracker.opts[optKey];
  out.value = `${r.value}″`;
  r.oninput = () => { tracker.opts[optKey] = Number(r.value); out.value = `${r.value}″`; store.set(key, Number(r.value)); };
}
{
  const btn = $('#sideToggle');
  const show = (open) => {
    document.body.classList.toggle('side-hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide panel' : 'Show panel';
    store.set('sideOpen', open);
  };
  show(store.get('sideOpen', true));
  btn.onclick = () => show(btn.getAttribute('aria-expanded') !== 'true');
}
bindRange('nextTo', 'nextTo', 'nextToInches');
bindRange('adjacent', 'adjacent', 'adjacentInches');
for (const [id, unit] of [['beamDeg', '°'], ['nearInches', '″'], ['farInches', '″'], ['padReachInches', '″'], ['padCurve', '×']]) {
  const r = $('#' + id), out = $('#' + id + 'Out');
  r.value = sonarOpts[id];
  out.value = `${id === 'beamDeg' ? '±' : ''}${r.value}${unit}`;
  r.oninput = () => { sonarOpts[id] = Number(r.value); out.value = `${id === 'beamDeg' ? '±' : ''}${r.value}${unit}`; store.set(id, Number(r.value)); };
}
// Tick speeds: the sliders show ticks per second; the config stores the period in ms.
for (const id of ['fastMs', 'slowMs']) {
  const r = $('#' + id), out = $('#' + id + 'Out');
  const show = () => { const hz = Number(r.value); out.value = `${hz < 1 ? hz.toFixed(2).replace(/0$/, '') : hz}/s`; };
  r.value = Math.round((1000 / sonarOpts[id]) * 4) / 4; // sliders step in quarter ticks per second
  show();
  r.oninput = () => {
    sonarOpts[id] = Math.round(1000 / Number(r.value));
    store.set(id, sonarOpts[id]);
    show();
  };
}
{
  const r = $('#missing'), out = $('#missingOut');
  tracker.opts.missingMs = store.get('missingMs', cfg.missingMs);
  r.value = tracker.opts.missingMs / 1000;
  out.value = `${r.value} s`;
  r.oninput = () => { tracker.opts.missingMs = Number(r.value) * 1000; out.value = `${r.value} s`; store.set('missingMs', tracker.opts.missingMs); };
}

// ---------- pointer facing ----------
{
  const box = $('#pointerFacing');
  for (const [id, p] of Object.entries(pointerCfg)) {
    const sel = document.createElement('select');
    sel.id = `facing-${id}`;
    for (const [deg, label] of [[0, 'Top edge (arrow)'], [90, 'Right edge'], [180, 'Bottom edge'], [270, 'Left edge']]) sel.append(new Option(label, deg));
    sel.value = String(pointerOffsets[id] || 0);
    sel.onchange = () => {
      pointerOffsets[id] = Number(sel.value);
      store.set('pointerOffsets', pointerOffsets);
      if (cam.stream) observe();
    };
    const lab = Object.assign(document.createElement('label'), { htmlFor: sel.id, textContent: `${p.name} (#${id}) points from` });
    sel.className = 'wide';
    box.append(lab, sel);
  }
}

// ---------- mixer ----------
{
  const firstPitch = Object.values(pointerCfg)[0]?.pitch ?? 3000;
  const channels = [
    ['master', 'Master', () => { speaker.tone('placed', { force: true }); sonar.preview(firstPitch, 3); }],
    ['speech', 'Speech', () => speaker.say('Speech level.', { interrupt: true, force: true })],
    ['tones', 'Tones', () => speaker.tone('enter', { force: true })],
    ['ticks', 'Pointer ticks', () => sonar.preview(firstPitch)],
    ['pad', 'Easter egg', () => sonar.previewPad()],
  ];
  const box = $('#mixer');
  for (const [key, label, preview] of channels) {
    const id = `mix-${key}`;
    const lab = Object.assign(document.createElement('label'), { htmlFor: id, textContent: label });
    const r = Object.assign(document.createElement('input'), { type: 'range', id, min: 0, max: 100, step: 1, value: Math.round(speaker.mix[key] * 100) });
    const out = Object.assign(document.createElement('output'), { value: `${r.value}%` });
    const btn = Object.assign(document.createElement('button'), { textContent: '▶', title: `Preview ${label.toLowerCase()}` });
    btn.setAttribute('aria-label', `Preview ${label}`);
    r.oninput = () => { out.value = `${r.value}%`; speaker.setMix({ [key]: r.value / 100 }); store.set('mix', speaker.mix); sonar._syncPad(); };
    r.onchange = preview; // hear the new level when you let go of the slider
    btn.onclick = preview;
    box.append(lab, r, out, btn);
  }
}

// ---------- save / reset defaults (zones.json) ----------
const SETTING_KEYS = ['mix', 'pointerOffsets','nextTo', 'adjacent', 'missingMs', 'beamDeg', 'nearInches', 'farInches', 'fastMs', 'slowMs', 'padReachInches', 'padCurve'];

/** zones.json with the panel's current settings written in. */
function currentConfig() {
  const out = structuredClone(cfg);
  out.nextToInches = tracker.opts.nextToInches;
  out.adjacentInches = tracker.opts.adjacentInches;
  out.missingMs = tracker.opts.missingMs;
  out.sonar = {
    ...cfg.sonar, beamDeg: sonarOpts.beamDeg, nearInches: sonarOpts.nearInches, farInches: sonarOpts.farInches,
    fastMs: sonarOpts.fastMs, slowMs: sonarOpts.slowMs,
    padReachInches: sonarOpts.padReachInches, padCurve: sonarOpts.padCurve,
  };
  for (const [id, p] of Object.entries(out.pointers || {})) p.offsetDeg = pointerOffsets[id] || 0;
  out.mix = Object.fromEntries(Object.entries(speaker.mix).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return out;
}

/** Pretty JSON in the file's own style: number arrays and point lists stay on one line. */
function formatConfig(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/\[\s+([-\d.e]+(?:,\s+[-\d.e]+)*)\s+\]/g, (_, s) => `[${s.split(/,\s+/).join(', ')}]`)
    .replace(/\[\s+(\[[^\[\]]*\](?:,\s+\[[^\[\]]*\])*)\s+\]/g, (_, s) => `[${s.split(/\],\s+\[/).join('], [')}]`) + '\n';
}

async function copyConfig() {
  const text = formatConfig(currentConfig()), msg = $('#saveMsg');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / blocked clipboard: copy through a hidden text box instead.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { msg.textContent = 'Copy failed: this browser blocked the clipboard.'; return; }
  }
  msg.textContent = 'Copied. Paste it over everything in prototype/zones.json and save to make these the defaults.';
}

// Writing the file directly only works in browsers with the File System Access API (Chrome, Edge).
async function saveConfig() {
  const msg = $('#saveMsg');
  try {
    const h = await window.showSaveFilePicker({ suggestedName: 'zones.json', id: 'zones-config', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    const w = await h.createWritable();
    await w.write(formatConfig(currentConfig())); await w.close();
    msg.textContent = `Saved ${h.name}. If that was prototype/zones.json, these are now the defaults.`;
  } catch (e) {
    if (e.name !== 'AbortError') msg.textContent = `Couldn't save (${e.message}). Use Copy JSON instead.`;
  }
}
$('#copyDefaults').onclick = copyConfig;
if (window.showSaveFilePicker) $('#saveDefaults').onclick = saveConfig;
else $('#saveDefaults').hidden = true;
$('#resetDefaults').onclick = () => {
  for (const k of SETTING_KEYS) { try { localStorage.removeItem('zones.' + k); } catch {} }
  location.reload();
};

// ---------- wiring ----------
$('#start').onclick = () => (cam.stream ? stopCam() : startCam());
$('#camSelect').onchange = () => cam.stream && startCam();
$('#recal').onclick = () => { cam.recalibrate(); rotation = null; store.set('rotation', null); };
$('#rotate').onclick = () => { rotation = ((rotation ?? 0) + 90) % 360; store.set('rotation', rotation); applyRotation(); renderMap(); };
$('#clearLog').onclick = () => $('#log').replaceChildren();
listCameras().catch(() => {});
renderNow();
