// Zone relations page: camera tokens (and draggable test tokens) -> in / out / next to / adjacent.
import { applyH } from './core.js';
import { SheetCam, SHEET, CORNER_IDS } from './sheetcam.js';
import { RelationTracker } from './zonecore.js';
import { Speaker } from './audio.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const TOKEN_R = 112; // 0.75" token, in sheet px

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('zones.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('zones.' + k, JSON.stringify(v)); } catch {} },
};

const cfg = await (await fetch('zones.json')).json();
const zones = cfg.zones;
const tracker = new RelationTracker(zones, {
  dpi: cfg.sheet.dpi, holdMs: cfg.holdMs, missingMs: cfg.missingMs, tokenNames: { ...cfg.tokenNames },
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
  const events = tracker.update(obs, Date.now());
  for (const ev of events) logEvent(ev);
  speaker.announce(events);
  renderMap();
  renderNow();
}
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
    octx.font = `700 ${lw * 14}px Helvetica, Arial, sans-serif`; octx.fillStyle = z.color; octx.textAlign = 'center';
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
    octx.font = `600 ${lw * 9}px Helvetica, Arial, sans-serif`; octx.fillStyle = col;
    octx.fillText(`${tracker.name(String(t.id))}${s ? ' · ' + (s.zone ? zoneById[s.zone].name : 'out') : ''}`, t.cam[0] + lw * 12, t.cam[1]);
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
applyRotation();

function renderMap() {
  live.replaceChildren();
  const snap = tracker.snapshot(), byId = Object.fromEntries(snap.map((s) => [s.id, s]));
  for (const s of snap) for (const o of s.adjacent) if (s.id < o && byId[o]) el('line', { class: 'adj', x1: s.pt[0], y1: s.pt[1], x2: byId[o].pt[0], y2: byId[o].pt[1] }, live);
  const shown = [...testTokens.map((t) => ({ id: t.id, pt: t.pt, test: true })), ...camTokens.map((t) => ({ id: String(t.id), pt: t.pt }))];
  // Covered tokens the tracker still remembers: draw them faded at their last position.
  const visible = new Set(shown.map((t) => t.id));
  for (const s of snap) if (!visible.has(s.id)) shown.push({ id: s.id, pt: s.pt, hidden: true });
  for (const t of shown) {
    const s = byId[t.id], g = el('g', { class: `tok${t.test ? ' test' : ''}`, 'data-id': t.id, opacity: t.hidden ? 0.35 : 1 }, live);
    for (const [i, zid] of (s?.near || []).entries()) el('circle', { class: 'ring', cx: t.pt[0], cy: t.pt[1], r: TOKEN_R + 40 + i * 30, stroke: zoneById[zid].color }, g);
    el('circle', { class: 'body', cx: t.pt[0], cy: t.pt[1], r: TOKEN_R, fill: s?.zone ? zoneById[s.zone].color : s ? '#555' : '#aaa' }, g);
    const label = el('text', { x: t.pt[0], y: t.pt[1] }, g);
    label.textContent = t.test ? t.id : t.id;
    // keep labels upright when the map is rotated
    if (rotation) label.setAttribute('transform', `rotate(${-rotation} ${t.pt[0]} ${t.pt[1]})`);
  }
}

// Drag test tokens.
let drag = null;
const toSheet = (e) => { const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(rot.getScreenCTM().inverse()); return [p.x, p.y]; };
svg.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('.tok.test');
  if (!g) return;
  drag = testTokens.find((t) => t.id === g.dataset.id);
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
$('#clearTest').onclick = () => { testTokens = []; store.set('tests', testTokens); };

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
  return parts.join(' ');
}

function bindAudio() {
  const sp = $('#speech'), tn = $('#tones'), rate = $('#rate'), voice = $('#voice');
  speaker.onSay = (text) => { $('#lastSaid').textContent = `Said: ${text}`; };  if (!speaker.supported.speech) { sp.disabled = true; sp.parentElement.title = 'This browser has no speech'; }
  sp.checked = speaker.speech; tn.checked = speaker.tones; rate.value = speaker.rate; $('#rateOut').value = `${speaker.rate}×`;
  sp.onchange = () => { speaker.speech = sp.checked; if (!sp.checked) speaker.stop(); saveAudio(); };
  tn.onchange = () => { speaker.tones = tn.checked; saveAudio(); };
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
});
bindAudio();

// ---------- settings ----------
function bindRange(id, key, optKey) {
  const r = $('#' + id), out = $('#' + id + 'Out');
  r.value = tracker.opts[optKey];
  out.value = `${r.value}″`;
  r.oninput = () => { tracker.opts[optKey] = Number(r.value); out.value = `${r.value}″`; store.set(key, Number(r.value)); };
}
bindRange('nextTo', 'nextTo', 'nextToInches');
bindRange('adjacent', 'adjacent', 'adjacentInches');
{
  const r = $('#missing'), out = $('#missingOut');
  tracker.opts.missingMs = store.get('missingMs', cfg.missingMs);
  r.value = tracker.opts.missingMs / 1000;
  out.value = `${r.value} s`;
  r.oninput = () => { tracker.opts.missingMs = Number(r.value) * 1000; out.value = `${r.value} s`; store.set('missingMs', tracker.opts.missingMs); };
}

// ---------- wiring ----------
$('#start').onclick = () => (cam.stream ? stopCam() : startCam());
$('#camSelect').onchange = () => cam.stream && startCam();
$('#recal').onclick = () => { cam.recalibrate(); rotation = null; store.set('rotation', null); };
$('#rotate').onclick = () => { rotation = ((rotation ?? 0) + 90) % 360; store.set('rotation', rotation); applyRotation(); renderMap(); };
$('#clearLog').onclick = () => $('#log').replaceChildren();
listCameras().catch(() => {});
renderNow();
