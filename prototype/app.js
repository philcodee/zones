import {
  homography, applyH, invert3, roomAt, centroid, isBookable, cornerPinMatrix, BookingEngine,
} from './core.js';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const SIM_TOKENS = [10, 11, 12, 20, 21, 22, 30, 31, 32];

// ---------- persistence ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('zones.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('zones.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const settings = Object.assign(
  { source: 'sim', rotation: 90, includeMaybe: false, cameraId: null, pins: null },
  store.get('settings', {}),
);
const saveSettings = () => store.set('settings', settings);

// ---------- data ----------

const plan = await (await fetch('plan.json')).json();
const TOKEN_SIZE = plan.tokenSize || 300; // a printed token's size, in plan px
const roomsFile =(await (await fetch('rooms.json')).json()).rooms;
let rooms = store.get('roomsOverride', null) || structuredClone(roomsFile);

const engine = new BookingEngine({ rooms, durations: plan.tokens, includeMaybe: settings.includeMaybe });
engine.restore(store.get('bookings', []), Date.now());
const saveBookings = () => store.set('bookings', [...engine.bookings.values()]);

const roomName = (id) => {
  const r = rooms.find((x) => x.id === id);
  return r ? `${r.name} ${r.number}` : 'off the plan';
};
const tokenLabel = (id) => `#${id}`;

// ---------- map ----------

const svg = $('#map'), rot = $('#rot');
const W = plan.width, H = plan.height;
let editMode = false;

function applyRotation() {
  const r = settings.rotation;
  const t = { 0: '', 90: `translate(${H} 0) rotate(90)`, 180: `translate(${W} ${H}) rotate(180)`, 270: `translate(0 ${W}) rotate(270)` }[r];
  const [vw, vh] = r % 180 ? [H, W] : [W, H];
  rot.setAttribute('transform', t);
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  layoutStage();
}

const img = $('#planImage');
img.setAttribute('href', plan.image);
img.setAttribute('width', W);
img.setAttribute('height', H);
const bounds = $('#planBounds');
bounds.setAttribute('width', W);
bounds.setAttribute('height', H);

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function fmtLeft(ms) {
  const s = Math.ceil(ms / 1000);
  if (s >= 60) return `${Math.ceil(s / 60)} min left`;
  return `${s}s left`;
}

function renderRooms(now) {
  const g = $('#rooms');
  g.replaceChildren();
  for (const r of rooms) {
    const st = engine.status(r.id, now);
    const group = el('g', { class: `room ${st.state}`, 'data-id': r.id });
    group.append(el('polygon', { points: r.points.map((p) => p.join(',')).join(' ') }));

    const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]);
    const minDim = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const u = Math.max(44, Math.min(120, minDim * 0.13));
    const [cx, cy] = centroid(r.points);
    const label = el('g', { class: 'label', transform: `translate(${cx} ${cy}) rotate(${-settings.rotation})` });

    if (st.state === 'inactive') {
      label.append(el('text', { class: 'num', y: 0, 'font-size': u * 0.8 }, r.number));
      label.append(el('text', { class: 'name', y: u * 0.9, 'font-size': u * 0.55 }, r.name));
    } else {
      label.append(el('text', { class: 'num', y: -u * 0.35, 'font-size': u * 1.3 }, r.number));
      label.append(el('text', { class: 'name', y: u * 0.45, 'font-size': u * 0.62 }, r.name));
      const line = st.state === 'booked' ? `${tokenLabel(st.booking.tokenId)} · ${fmtLeft(st.remainingMs)}` : 'Available';
      label.append(el('text', { class: 'state', y: u * 1.35, 'font-size': u * 0.7 }, line));
    }
    group.append(label);
    g.append(group);
  }
}

function renderTokens(now) {
  const g = $('#tokens');
  g.replaceChildren();
  const s = TOKEN_SIZE;
  for (const t of engine.tokens.values()) {
    if (!t.pt) continue;
    const settling = t.candidate !== t.room;
    const progress = settling ? Math.min(1, (now - t.since) / engine.stableMs) : 1;
    const holds = t.room && engine.bookings.get(t.room)?.tokenId === t.id;
    const cls = holds ? 'holds' : t.blocked ? `blocked ${t.blocked}` : t.spent ? 'spent' : settling ? 'settling' : 'idle';
    const unseen = now - t.lastSeen > 300 ? ' unseen' : ''; // lifted, inside the grace window
    const tg = el('g', { class: `token ${cls}${unseen}`, 'data-id': t.id, transform: `translate(${t.pt[0]} ${t.pt[1]})` });
    tg.append(el('rect', { class: 'chip', x: -s / 2, y: -s / 2, width: s, height: s, rx: 18 }));
    const r = s * 0.78, circ = 2 * Math.PI * r;
    tg.append(el('circle', { class: 'ring', r, 'stroke-dasharray': `${circ * progress} ${circ}`, transform: 'rotate(-90)' }));
    const lab = el('g', { transform: `rotate(${-settings.rotation})` });
    lab.append(el('text', { class: 'tid', y: -10, 'font-size': 96 }, t.id));
    lab.append(el('text', { class: 'tdur', y: 80, 'font-size': 62 }, `${plan.tokens[t.id]}m`));
    const note = { conflict: 'Room taken', 'not-bookable': 'Not bookable' }[t.blocked] || (t.spent && !holds ? 'Expired · lift' : '');
    if (note) lab.append(el('text', { class: 'tnote', y: s * 0.95, 'font-size': 60 }, note));
    tg.append(lab);
    g.append(tg);
  }
}

function renderHandles() {
  const g = $('#handles');
  g.replaceChildren();
  if (!editMode) return;
  rooms.forEach((r, ri) => r.points.forEach((p, pi) => {
    g.append(el('circle', { class: 'handle', cx: p[0], cy: p[1], r: 30, 'data-room': ri, 'data-pt': pi }));
  }));
}

function renderList(now) {
  const list = $('#roomList');
  list.replaceChildren();
  let avail = 0, booked = 0;
  const order = { booked: 0, available: 1, inactive: 2 };
  const rows = rooms
    .map((r) => ({ r, st: engine.status(r.id, now) }))
    .filter(({ st }) => st.state !== 'inactive')
    .sort((a, b) => order[a.st.state] - order[b.st.state] || a.r.number.localeCompare(b.r.number));
  for (const { r, st } of rows) {
    st.state === 'booked' ? booked++ : avail++;
    const li = document.createElement('li');
    li.className = st.state;
    li.innerHTML = `<i class="sw ${st.state}"></i><span class="rnum mono">${r.number}</span>
      <span class="rname">${r.name}</span>
      <span class="rstate mono">${st.state === 'booked' ? `${tokenLabel(st.booking.tokenId)} · ${fmtLeft(st.remainingMs)}` : 'open'}</span>`;
    if (st.state === 'booked') {
      const b = document.createElement('button');
      b.className = 'end';
      b.title = 'End this booking';
      b.textContent = 'End';
      b.onclick = () => handle(engine.cancel(r.id, Date.now()));
      li.append(b);
    }
    list.append(li);
  }
  $('#counts').textContent = `${avail} open · ${booked} booked`;
}

function render() {
  const now = Date.now();
  renderRooms(now);
  renderTokens(now);
  renderList(now);
  $('#clock').textContent = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---------- events, log, toast ----------

const EVENT_TEXT = {
  booked: (e) => `${roomName(e.roomId)} booked by ${tokenLabel(e.tokenId)} for ${e.minutes} min`,
  ended: (e) => `${roomName(e.roomId)} free · ${tokenLabel(e.tokenId)} lifted`,
  expired: (e) => `${roomName(e.roomId)} booking expired`,
  cancelled: (e) => `${roomName(e.roomId)} booking ended manually`,
  conflict: (e) => `${roomName(e.roomId)} is already booked`,
  'not-bookable': (e) => `${roomName(e.roomId)} can’t be booked`,
};

let toastTimer;
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind || ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

function handle(events) {
  if (!events.length) return;
  const log = $('#log');
  for (const e of events) {
    const li = document.createElement('li');
    const time = new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<span class="t">${time}</span> ${EVENT_TEXT[e.type](e)}`;
    li.className = e.type;
    log.prepend(li);
    if (e.type === 'conflict' || e.type === 'not-bookable') toast(EVENT_TEXT[e.type](e), 'warn');
    if (e.type === 'booked') toast(EVENT_TEXT[e.type](e), 'ok');
  }
  while (log.children.length > 30) log.lastChild.remove();
  saveBookings();
  render();
}

// ---------- plan coordinates from the pointer ----------

function clientToPlan(x, y) {
  const p = svg.createSVGPoint();
  p.x = x; p.y = y;
  const q = p.matrixTransform(rot.getScreenCTM().inverse());
  return [q.x, q.y];
}

function overMap(x, y) {
  const r = svg.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  const [px, py] = clientToPlan(x, y);
  return px >= 0 && py >= 0 && px <= W && py <= H;
}

// ---------- simulate source ----------

const sim = new Map(); // tokenId -> plan point (only tokens resting on the table)
let drag = null;

function renderTray() {
  const tray = $('#tray');
  tray.replaceChildren();
  for (const id of SIM_TOKENS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.token = id;
    b.disabled = sim.has(id);
    b.innerHTML = `<b>#${id}</b><span>${plan.tokens[id]} min</span>`;
    tray.append(b);
  }
}

function startDrag(id, e) {
  drag = { id };
  sim.delete(id); // in hand = not seen by the camera
  const ghost = $('#ghost');
  ghost.textContent = `#${id}`;
  ghost.hidden = false;
  moveGhost(e);
  renderTray();
}
function moveGhost(e) {
  const ghost = $('#ghost');
  ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  ghost.classList.toggle('over', overMap(e.clientX, e.clientY));
}

$('#tray').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.chip');
  if (!b || b.disabled || settings.source !== 'sim') return;
  e.preventDefault();
  startDrag(Number(b.dataset.token), e);
});

svg.addEventListener('pointerdown', (e) => {
  if (editMode) {
    const h = e.target.closest('.handle');
    if (h) { e.preventDefault(); drag = { room: Number(h.dataset.room), pt: Number(h.dataset.pt) }; }
    return;
  }
  const t = e.target.closest('.token');
  if (t && settings.source === 'sim' && sim.has(Number(t.dataset.id))) {
    e.preventDefault();
    startDrag(Number(t.dataset.id), e);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.room != null) {
    rooms[drag.room].points[drag.pt] = clientToPlan(e.clientX, e.clientY).map(Math.round);
    renderRooms(Date.now());
    renderHandles();
  } else moveGhost(e);
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.room != null) {
    store.set('roomsOverride', rooms);
    engine.setRooms(rooms);
  } else {
    if (overMap(e.clientX, e.clientY)) sim.set(drag.id, clientToPlan(e.clientX, e.clientY));
    $('#ghost').hidden = true;
    renderTray();
  }
  drag = null;
});

function simObservations() {
  return [...sim].map(([id, pt]) => ({ id, pt, room: roomAt(pt, rooms)?.id ?? null }));
}

// ---------- camera source ----------

const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const grab = document.createElement('canvas'), gctx = grab.getContext('2d', { willReadFrequently: true });
const worker = new Worker('detector.worker.js');
let stream = null, busy = false, calib = null, lastMarkers = [], fps = 0, lastFrameAt = 0;

async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('#camSelect');
  sel.replaceChildren(...devices.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (settings.cameraId && devices.some((d) => d.deviceId === settings.cameraId)) sel.value = settings.cameraId;
}

async function startCamera() {
  stopCamera();
  const deviceId = $('#camSelect').value || settings.cameraId;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      audio: false,
    });
  } catch (err) {
    $('#camStatus').textContent = `Camera error: ${err.message}`;
    return;
  }
  video.srcObject = stream;
  await video.play();
  anchors = {};
  calib = null;
  settings.cameraId = stream.getVideoTracks()[0].getSettings().deviceId;
  saveSettings();
  await listCameras();
  $('#camStart').textContent = 'Stop';
  requestAnimationFrame(cameraLoop);
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  busy = false;
  $('#camStart').textContent = 'Start';
  $('#camStatus').textContent = 'Camera off';
}

async function lockCamera() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  const adv = {};
  if (caps.focusMode?.includes('manual')) adv.focusMode = 'manual';
  if (caps.exposureMode?.includes('manual')) adv.exposureMode = 'manual';
  if (caps.whiteBalanceMode?.includes('manual')) adv.whiteBalanceMode = 'manual';
  if (!Object.keys(adv).length) return toast('This camera doesn’t allow locking focus or exposure here', 'warn');
  try {
    await track.applyConstraints({ advanced: [adv] });
    toast(`Locked: ${Object.keys(adv).map((k) => k.replace('Mode', '')).join(', ')}`, 'ok');
  } catch (err) { toast(`Lock failed: ${err.message}`, 'warn'); }
}

function cameraLoop() {
  if (!stream) return;
  if (!busy && video.readyState >= 2) {
    const w = video.videoWidth, h = video.videoHeight;
    if (grab.width !== w) { grab.width = overlay.width = w; grab.height = overlay.height = h; }
    gctx.drawImage(video, 0, 0, w, h);
    const { data } = gctx.getImageData(0, 0, w, h);
    busy = true;
    worker.postMessage({ w, h, buffer: data.buffer }, [data.buffer]);
  }
  drawOverlay();
  requestAnimationFrame(cameraLoop);
}

worker.onmessage = ({ data }) => {
  busy = false;
  if (!stream || settings.source !== 'camera') return;
  const now = Date.now();
  fps = fps * 0.8 + (1000 / Math.max(1, now - lastFrameAt)) * 0.2;
  lastFrameAt = now;
  lastMarkers = data.markers;

  const corners = data.markers.filter((m) => m.id in plan.corners && m.exact);
  for (const m of corners) trackCorner(m);
  updateCalibration(now);

  const seen = new Set(corners.map((m) => m.id));
  const dots = [0, 1, 2, 3].map((i) => (seen.has(i) ? '●' : '○')).join('');
  const known = Object.keys(anchors).length;
  const tokens = data.markers.filter((m) => m.id in plan.tokens);
  $('#camStatus').textContent =
    `Corners ${dots}  ${calib ? `calibrated (${known}/4)` : `finding corners (${known}/4)`}` +
    `  ·  ${tokens.length} token${tokens.length === 1 ? '' : 's'}  ·  ${grab.width}×${grab.height}  ·  ${fps.toFixed(0)} fps`;

  if (!calib) return handle(engine.update(null, now));
  const obs = tokens.map((m) => {
    const c = m.corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const pt = applyH(calib.H, c);
    return { id: m.id, pt, room: roomAt(pt, rooms)?.id ?? null };
  });
  handle(engine.update(obs, now));
  renderTokens(now);
};

// ---------- calibration ----------
// The paper and camera don't move, so calibration is held, not recomputed each frame.
// Each corner marker keeps a smoothed position. Small differences between frames are
// sensor noise and get averaged away. A covered corner keeps its last position. Only a
// corner that is consistently somewhere new (paper or camera bumped) snaps to it.

const SMOOTHING = 0.15;   // weight of each new reading
const MOVE_FRAMES = 6;    // consecutive "moved" readings before re-snapping (~0.5 s)
let anchors = {};         // corner id -> { pts: [[x,y] x4], moved: n }

function trackCorner(m) {
  const a = anchors[m.id];
  if (!a) { anchors[m.id] = { pts: m.corners.map((p) => [...p]), moved: 0 }; return; }
  const side = Math.sqrt(markerArea(a.pts));
  const dist = Math.max(...m.corners.map((p, i) => Math.hypot(p[0] - a.pts[i][0], p[1] - a.pts[i][1])));
  if (dist < side * 0.12) {
    a.moved = 0;
    a.pts = a.pts.map((p, i) => [p[0] + (m.corners[i][0] - p[0]) * SMOOTHING, p[1] + (m.corners[i][1] - p[1]) * SMOOTHING]);
  } else if (++a.moved >= MOVE_FRAMES) {
    a.pts = m.corners.map((p) => [...p]);
    a.moved = 0;
  }
}

function updateCalibration(now) {
  const ids = Object.keys(anchors);
  if (ids.length < 3) return; // 3 markers = 12 points, enough for the mapping
  const half = plan.markerSize / 2, src = [], dst = [];
  for (const id of ids) {
    const [cx, cy] = plan.corners[id];
    [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]]
      .forEach((p, i) => { src.push(anchors[id].pts[i]); dst.push(p); });
  }
  const Hm = homography(src, dst);
  const Hinv = Hm && invert3(Hm);
  if (!Hinv) return;
  // A misread marker shows up as points that don't fit the rest; ignore that fit.
  const err = Math.max(...dst.map((p, i) => Math.hypot(...applyH(Hinv, p).map((v, k) => v - src[i][k]))));
  const side = Math.sqrt(ids.reduce((s, id) => s + markerArea(anchors[id].pts), 0) / ids.length);
  if (err < side * 0.15) calib = { H: Hm, Hinv, at: now };
}

function recalibrate() {
  anchors = {};
  calib = null;
  toast('Recalibrating: keep all four corners in view', 'ok');
}

function markerArea(c) {
  let a = 0;
  for (let i = 0, j = 3; i < 4; j = i++) a += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
  return Math.abs(a / 2);
}

function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const lw = Math.max(2, w / 640);
  if (calib) {
    const now = Date.now();
    for (const r of rooms) {
      const st = engine.status(r.id, now).state;
      octx.beginPath();
      r.points.forEach((p, i) => { const [x, y] = applyH(calib.Hinv, p); i ? octx.lineTo(x, y) : octx.moveTo(x, y); });
      octx.closePath();
      octx.lineWidth = lw;
      octx.strokeStyle = st === 'booked' ? '#ff5a3c' : st === 'available' ? '#3fd07f' : 'rgba(255,255,255,.55)';
      octx.stroke();
    }
  }
  for (const m of lastMarkers) {
    octx.beginPath();
    m.corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.closePath();
    octx.lineWidth = lw * 1.5;
    octx.strokeStyle = m.id in plan.corners ? '#ffd23f' : '#3fa9ff';
    octx.stroke();
    octx.fillStyle = octx.strokeStyle;
    octx.font = `${lw * 9}px ui-monospace, Menlo, monospace`;
    octx.fillText(`#${m.id}`, m.corners[0][0], m.corners[0][1] - lw * 3);
  }
}

$('#camStart').onclick = () => (stream ? stopCamera() : startCamera());
$('#camLock').onclick = lockCamera;
$('#camRecal').onclick = recalibrate;
$('#camSelect').onchange = () => stream && startCamera();

// ---------- source switching ----------

function setSource(src) {
  settings.source = src;
  saveSettings();
  document.querySelectorAll('[data-source]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.source === src));
  $('#simPanel').hidden = src !== 'sim';
  $('#camPanel').hidden = src !== 'camera';
  if (src === 'camera') listCameras().catch(() => {});
  else stopCamera();
}
document.querySelectorAll('[data-source]').forEach((b) => (b.onclick = () => setSource(b.dataset.source)));

// The sim "camera" reports 10 times a second; the camera reports as fast as it detects.
// With no live source, a null tick still lets bookings expire.
setInterval(() => {
  const now = Date.now();
  if (settings.source === 'sim') handle(engine.update(simObservations(), now));
  else if (!stream || !calib) handle(engine.update(null, now));
  renderTokens(now);
}, 100);
setInterval(render, 1000);

// ---------- header controls ----------

$('#includeMaybe').checked = settings.includeMaybe;
$('#includeMaybe').onchange = (e) => {
  settings.includeMaybe = engine.includeMaybe = e.target.checked;
  saveSettings();
  render();
};

$('#rotate').onclick = () => {
  settings.rotation = (settings.rotation + 90) % 360;
  saveSettings();
  applyRotation();
  render();
  renderHandles();
};

$('#editRooms').onclick = () => {
  editMode = !editMode;
  $('#editRooms').setAttribute('aria-pressed', editMode);
  document.body.classList.toggle('editing', editMode);
  $('#editPanel').hidden = !editMode;
  renderHandles();
};

$('#roomsDownload').onclick = () => {
  const blob = new Blob([JSON.stringify({ _units: 'pixels of assets/floor-plan.png (3952 x 5194, portrait)', rooms }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'rooms.json' });
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#roomsReset').onclick = () => {
  rooms = structuredClone(roomsFile);
  store.set('roomsOverride', null);
  engine.setRooms(rooms);
  render();
  renderHandles();
};

// ---------- projector ----------

const stage = $('#stage');
let aligning = false;

function stageSize() {
  const [vw, vh] = settings.rotation % 180 ? [H, W] : [W, H];
  const s = Math.min(innerWidth / vw, innerHeight / vh);
  return [vw * s, vh * s];
}

function defaultPins() {
  const [w, h] = stageSize();
  const x = (innerWidth - w) / 2, y = (innerHeight - h) / 2;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

function layoutStage() {
  if (!document.body.classList.contains('projector')) {
    stage.style.width = stage.style.height = stage.style.transform = '';
    return;
  }
  const [w, h] = stageSize();
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.transform = cornerPinMatrix(w, h, settings.pins || defaultPins());
  renderPins();
}

function renderPins() {
  const box = $('#pins');
  box.hidden = !aligning;
  box.replaceChildren();
  if (!aligning) return;
  (settings.pins || defaultPins()).forEach(([x, y], i) => {
    const d = document.createElement('div');
    d.className = 'pin';
    d.dataset.i = i;
    d.style.transform = `translate(${x}px, ${y}px)`;
    box.append(d);
  });
}

$('#pins').addEventListener('pointerdown', (e) => {
  const p = e.target.closest('.pin');
  if (!p) return;
  e.preventDefault();
  const i = Number(p.dataset.i);
  settings.pins = settings.pins || defaultPins();
  const move = (ev) => { settings.pins[i] = [ev.clientX, ev.clientY]; layoutStage(); };
  const up = () => { saveSettings(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

function enterProjector() {
  if (editMode) $('#editRooms').click();
  document.body.classList.add('projector');
  document.documentElement.requestFullscreen?.().catch(() => {});
  const hint = $('#projHint');
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 3500);
  layoutStage();
}

function exitProjector() {
  aligning = false;
  document.body.classList.remove('projector', 'aligning');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  layoutStage();
  renderPins();
}

$('#projector').onclick = enterProjector;
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitProjector(); });
addEventListener('resize', layoutStage);
addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('projector')) return;
  if (e.key === 'Escape') exitProjector();
  if (e.key === 'a' || e.key === 'A') {
    aligning = !aligning;
    document.body.classList.toggle('aligning', aligning);
    renderPins();
  }
  if ((e.key === 'r' || e.key === 'R') && aligning) {
    settings.pins = null;
    saveSettings();
    layoutStage();
  }
});

// ---------- go ----------

applyRotation();
setSource(settings.source);
renderTray();
render();
