// ArUco calibration bench for the 11 × 17 portrait sheet ("studio map outline-2 11x17.jpg").
// Reuses detector.worker.js (DICT_4X4_50) and the homography helpers from core.js.
import { homography, applyH, invert3 } from './core.js';

// Sheet layout in pixels at 300 DPI. Tags are 300 px (1") squares, 6 × 6 modules of 50 px.
const SHEET = {
  w: 3300, h: 5100, dpi: 300, tag: 300,
  tags: { 0: [75, 75], 1: [2925, 75], 2: [2925, 4725], 3: [75, 4725] }, // top-left of each tag
  map: [75, 476, 3150, 4147], // x, y, w, h
};
const IDS = [0, 1, 2, 3];
// Printed patterns (OpenCV DICT_4X4_50, 6 × 6 incl. border, 1 = white), top row first.
const BITS = {
  0: '000000010110001010000110000100000000',
  1: '000000000000011110010010010100000000',
  2: '000000000110000110000100011010000000',
  3: '000000010010010010001000001100000000',
};
const CROP = 72; // px of the per-tag inspection crop (12 px per module)
const WINDOW = 90;   // frames of history for read rates
const JITTER_N = 30; // detections of history for jitter

const $ = (s) => document.querySelector(s);
const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const grab = document.createElement('canvas'), gctx = grab.getContext('2d', { willReadFrequently: true });
const worker = new Worker('detector.worker.js');

let stream = null, busy = false, scale = 1, fps = 0, lastAt = 0, detMs = 0;
let lastMarkers = [], fit = null, frames = 0, strays = 0, grayFrame = null, tick = 0, sentScale = 1;
const inspection = {}; // id -> { wrong, contrast, lookalike, diag }
let stats = freshStats();

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cal.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cal.' + k, JSON.stringify(v)); } catch {} },
};
$('#res').value = store.get('res', '1920x1080');
// js-aruco only marks a pixel black if it is darker than its 5 × 5 neighbourhood, so big
// squares turn into thin edge outlines that noise breaks. It reads best at ~3–5 px per square.
const TARGET_MOD = 4, SCALES = [1, 0.6, 0.4, 0.25];
let autoScale = true, missStreak = 0, sweep = 0;
$('#scale').value = String(store.get('detectScale', 'auto'));
if (!$('#scale').value) $('#scale').value = 'auto';
applyScaleSetting();
function applyScaleSetting() {
  autoScale = $('#scale').value === 'auto';
  if (!autoScale) scale = Number($('#scale').value);
}
function updateAutoScale() {
  if (!autoScale) return;
  const sides = IDS.map((id) => lastMarkers.find((m) => m.id === id)).filter(Boolean).map((m) => Math.sqrt(quadArea(m.corners)) / 6);
  if (sides.length) {
    missStreak = 0;
    const camMod = sides.sort((a, b) => a - b)[sides.length >> 1]; // median, full-res px per square
    const want = Math.min(1, Math.max(0.2, TARGET_MOD / camMod));
    if (Math.abs(want - scale) / scale > 0.15) { scale = want; stats = freshStats(); }
  } else if (++missStreak >= 8) {
    // Nothing found: try the next size until some tag shows up.
    missStreak = 0;
    scale = SCALES[sweep++ % SCALES.length];
  }
}

function freshStats() {
  const s = {};
  for (const id of IDS) s[id] = { seen: [], exact: [], centers: [], side: 0 };
  frames = 0; strays = 0;
  return s;
}
const push = (arr, v, n) => { arr.push(v); if (arr.length > n) arr.shift(); };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const pct = (a) => Math.round(mean(a.map(Number)) * 100);

// ---------- camera ----------

async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('#camSelect'), want = store.get('cam', null);
  sel.replaceChildren(...devs.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (want && devs.some((d) => d.deviceId === want)) sel.value = want;
}

async function start() {
  stop();
  const [w, h] = $('#res').value.split('x').map(Number);
  const deviceId = $('#camSelect').value || store.get('cam', null);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: w }, height: { ideal: h }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
  } catch (err) {
    $('#status').textContent = `Camera error: ${err.message}`;
    stream = null;
    return;
  }
  video.srcObject = stream;
  await video.play();
  store.set('cam', stream.getVideoTracks()[0].getSettings().deviceId);
  await listCameras();
  $('#stage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  $('#empty').hidden = true;
  $('#start').textContent = 'Stop camera';
  stats = freshStats();
  buildControls();
  requestAnimationFrame(loop);
}

function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null; busy = false; fit = null; lastMarkers = [];
  $('#start').textContent = 'Start camera';
  $('#status').textContent = 'Camera off';
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

function loop() {
  if (!stream) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!busy && video.readyState >= 2 && vw) {
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
    if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }
    gctx.drawImage(video, 0, 0, w, h);
    const img = gctx.getImageData(0, 0, w, h);
    if ($('#showGray').checked) grayFrame = toGray(img);
    if (fit && ++tick % 6 === 0) inspect(img);
    busy = true;
    sentScale = scale;
    worker.postMessage({ w, h, buffer: img.data.buffer }, [img.data.buffer]);
  }
  draw();
  requestAnimationFrame(loop);
}

function toGray(img) {
  const out = new ImageData(img.width, img.height), s = img.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const g = (s[i] + s[i + 1] + s[i + 2]) / 3; // same weighting js-aruco uses
    d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
  }
  return out;
}

worker.onmessage = ({ data }) => {
  busy = false;
  if (!stream) return;
  const now = performance.now();
  fps = fps * 0.85 + (1000 / Math.max(1, now - lastAt)) * 0.15;
  lastAt = now;
  detMs = detMs * 0.85 + data.ms * 0.15;
  frames++;

  // Detection ran on a scaled copy; put corners back into full video pixels.
  lastMarkers = data.markers.map((m) => ({ ...m, corners: m.corners.map(([x, y]) => [x / sentScale, y / sentScale]) }));
  strays += lastMarkers.filter((m) => !IDS.includes(m.id)).length;

  for (const id of IDS) {
    const m = lastMarkers.find((k) => k.id === id), s = stats[id];
    push(s.seen, !!m, WINDOW);
    push(s.exact, !!m?.exact, WINDOW);
    if (m) {
      s.side = Math.sqrt(quadArea(m.corners));
      push(s.centers, m.corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]), JITTER_N);
      s.last = m;
    }
  }
  fit = computeFit(lastMarkers.filter((m) => IDS.includes(m.id) && m.exact));
  updateAutoScale();
  render();
};

// ---------- geometry ----------

function quadArea(c) {
  let a = 0;
  for (let i = 0, j = 3; i < 4; j = i++) a += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
  return Math.abs(a / 2);
}

function tagCorners(id) {
  const [x, y] = SHEET.tags[id], t = SHEET.tag;
  return [[x, y], [x + t, y], [x + t, y + t], [x, y + t]]; // same order js-aruco returns
}

function computeFit(markers) {
  if (markers.length < 2) return null; // 2 tags = 8 points, the minimum for a stable fit
  const cam = [], sheet = [];
  for (const m of markers) tagCorners(m.id).forEach((p, i) => { sheet.push(p); cam.push(m.corners[i]); });
  const H = homography(sheet, cam); // sheet -> camera
  if (!H) return null;
  const errs = sheet.map((p, i) => Math.hypot(...applyH(H, p).map((v, k) => v - cam[i][k])));
  // Camera pixels per sheet inch, measured along the sheet's middle.
  const a = applyH(H, [SHEET.w / 2 - 150, SHEET.h / 2]), b = applyH(H, [SHEET.w / 2 + 150, SHEET.h / 2]);
  const pxPerIn = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const outline = [[0, 0], [SHEET.w, 0], [SHEET.w, SHEET.h], [0, SHEET.h]].map((p) => applyH(H, p));
  return {
    H, n: markers.length, rms: Math.sqrt(mean(errs.map((e) => e * e))), max: Math.max(...errs),
    pxPerIn, coverage: quadArea(outline) / (overlay.width * overlay.height),
  };
}

function jitter(centers) {
  if (centers.length < 5) return null;
  const cx = mean(centers.map((c) => c[0])), cy = mean(centers.map((c) => c[1]));
  return Math.sqrt(mean(centers.map((c) => (c[0] - cx) ** 2 + (c[1] - cy) ** 2)));
}

// ---------- per-tag inspection ----------
// Uses the sheet fit (from whichever tags did read) to look at where each tag should be,
// samples its 6 × 6 squares and compares them with the printed pattern. This explains a
// tag that never gets an outline: wrong pattern, low contrast, or blur flipping squares.

function rotations(bits) {
  const out = [bits];
  for (let r = 1; r < 4; r++) {
    const p = out[r - 1];
    let n = '';
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) n += p[(5 - x) * 6 + y]; // 90° clockwise
    out.push(n);
  }
  return out;
}
const diffBits = (a, b) => { let n = 0; for (let i = 0; i < 36; i++) n += a[i] !== b[i]; return n; };

function inspect(img) {
  const { width: W, height: H, data } = img;
  const lum = (x, y) => {
    x = Math.round(x * scale); y = Math.round(y * scale);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const i = (y * W + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  };
  for (const id of IDS) {
    const [tx, ty] = SHEET.tags[id], cv = document.querySelector(`.tag[data-id="${id}"] canvas`);
    const c = cv.getContext('2d'), out = c.createImageData(CROP, CROP);
    const mods = Array.from({ length: 36 }, () => []);
    let offFrame = false;
    for (let v = 0; v < CROP; v++) for (let u = 0; u < CROP; u++) {
      const [x, y] = applyH(fit.H, [tx + ((u + 0.5) / CROP) * SHEET.tag, ty + ((v + 0.5) / CROP) * SHEET.tag]);
      const g = lum(x, y), k = (v * CROP + u) * 4;
      if (g == null) { offFrame = true; out.data[k] = 255; out.data[k + 3] = 255; continue; }
      out.data[k] = out.data[k + 1] = out.data[k + 2] = g; out.data[k + 3] = 255;
      const mu = (u % 12), mv = (v % 12);
      if (mu >= 3 && mu < 9 && mv >= 3 && mv < 9) mods[((v / 12) | 0) * 6 + ((u / 12) | 0)].push(g); // centre of each square
    }
    c.putImageData(out, 0, 0);
    if (offFrame) { inspection[id] = { diag: 'Partly outside the frame' }; continue; }

    const m = mods.map(mean), exp = BITS[id];
    const thr = (Math.min(...m) + Math.max(...m)) / 2;
    const seen = m.map((g) => (g > thr ? '1' : '0')).join('');
    const contrast = mean(m.filter((_, i) => seen[i] === '1')) - mean(m.filter((_, i) => seen[i] === '0'));
    const whites = m.filter((_, i) => exp[i] === '1'), blacks = m.filter((_, i) => exp[i] === '0');
    const wrong = [...seen].map((b, i) => b !== exp[i]);
    const nWrong = wrong.filter(Boolean).length;

    // Is it actually one of the other corner tags (sheet printed or placed differently)?
    let lookalike = null;
    for (const other of IDS) {
      if (other === id) continue;
      if (rotations(BITS[other]).some((r) => diffBits(seen, r) <= 1)) lookalike = other;
    }
    const sharp = Math.min(...whites) - Math.max(...blacks); // >0: every square separable
    const diag =
      lookalike != null ? `Looks like tag ${lookalike}, not ${id}: wrong tag printed here?` :
      contrast < 50 ? 'Low contrast: glare, shadow or exposure' :
      nWrong >= 4 ? `Pattern doesn’t match tag ${id} (${nWrong} squares off): check the print` :
      nWrong > 0 ? `${nWrong} square${nWrong > 1 ? 's' : ''} misread: blur or glare` :
      sharp < 20 ? 'Pattern right but soft: focus or move closer' :
      'Pattern reads correctly here';
    inspection[id] = { wrong, nWrong, contrast, diag, ok: nWrong === 0 && contrast >= 50 && lookalike == null };

    // Mark misread squares in red on the crop.
    c.strokeStyle = '#ff3b1f'; c.lineWidth = 2;
    wrong.forEach((w, i) => w && c.strokeRect((i % 6) * 12 + 1, ((i / 6) | 0) * 12 + 1, 10, 10));
  }
}

// ---------- drawing ----------

function draw() {
  const w = overlay.width, h = overlay.height;
  if (!w) return;
  if ($('#showGray').checked && grayFrame) {
    // Show what the detector actually sees, at the resolution it sees it.
    if (grab.width === grayFrame.width) gctx.putImageData(grayFrame, 0, 0);
    octx.imageSmoothingEnabled = false;
    octx.drawImage(grab, 0, 0, grayFrame.width, grayFrame.height, 0, 0, w, h);
  } else {
    octx.clearRect(0, 0, w, h);
  }
  const lw = Math.max(2, w / 640);

  if (fit) {
    const line = (pts, close = true) => {
      octx.beginPath();
      pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      if (close) octx.closePath();
      octx.stroke();
    };
    const P = (x, y) => applyH(fit.H, [x, y]);
    if ($('#showGrid').checked) {
      octx.lineWidth = lw * 0.5; octx.strokeStyle = 'rgba(63,169,255,.55)';
      for (let x = 0; x <= SHEET.w; x += SHEET.dpi) line([P(x, 0), P(x, SHEET.h)], false);
      for (let y = 0; y <= SHEET.h; y += SHEET.dpi) line([P(0, y), P(SHEET.w, y)], false);
    }
    if ($('#showSheet').checked) {
      octx.lineWidth = lw; octx.strokeStyle = 'rgba(63,208,127,.9)';
      line([P(0, 0), P(SHEET.w, 0), P(SHEET.w, SHEET.h), P(0, SHEET.h)]);
      const [mx, my, mw, mh] = SHEET.map;
      octx.setLineDash([lw * 4, lw * 3]);
      line([P(mx, my), P(mx + mw, my), P(mx + mw, my + mh), P(mx, my + mh)]);
      octx.setLineDash([]);
      // Where each tag should be, from the fit. A tag that was missed still shows here.
      octx.lineWidth = lw * 0.75; octx.strokeStyle = 'rgba(255,255,255,.6)';
      for (const id of IDS) line(tagCorners(id).map((p) => P(...p)));
    }
  }

  octx.font = `${lw * 9}px ui-monospace, Menlo, monospace`;
  for (const m of lastMarkers) {
    const corner = IDS.includes(m.id);
    octx.strokeStyle = !corner ? '#3fa9ff' : m.exact ? '#ffd23f' : '#ff7a3c';
    octx.lineWidth = lw * 1.5;
    octx.beginPath();
    m.corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.closePath(); octx.stroke();
    octx.fillStyle = octx.strokeStyle;
    octx.beginPath(); octx.arc(m.corners[0][0], m.corners[0][1], lw * 2.5, 0, Math.PI * 2); octx.fill();
    const side = Math.sqrt(quadArea(m.corners));
    octx.fillText(`#${m.id} ${(side / 6).toFixed(1)}px/sq · det ${((side / 6) * sentScale).toFixed(1)}${m.exact ? '' : ' ~1bit'}`, m.corners[0][0], m.corners[0][1] - lw * 4);
  }
}

// ---------- readouts ----------

const grade = (v, good, ok, higherIsBetter = true) =>
  v == null ? '' : (higherIsBetter ? (v >= good ? 'ok' : v >= ok ? 'mid' : 'no') : (v <= good ? 'ok' : v <= ok ? 'mid' : 'no'));
const span = (cls, txt) => `<span class="${cls}">${txt}</span>`;

function render() {
  const vw = overlay.width, vh = overlay.height;
  let worst = 'good';
  const rank = { good: 0, warn: 1, bad: 2 };

  for (const id of IDS) {
    const s = stats[id], el = document.querySelector(`.tag[data-id="${id}"]`);
    const rate = pct(s.seen), exact = pct(s.exact), mod = s.side / 6, jit = jitter(s.centers);
    const detMod = mod * scale; // what the detector actually works with
    const modG = !s.side ? 'no' : mod < 3 ? 'no' : detMod >= 2.5 && detMod <= 6 ? 'ok' : detMod >= 2 && detMod <= 7.5 ? 'mid' : 'no';
    const g = [grade(rate, 95, 70), grade(exact, 90, 60), modG, jit == null ? '' : grade(jit, 1, 2.5, false)];
    const level = g.includes('no') ? 'bad' : g.includes('mid') ? 'warn' : 'good';
    if (rank[level] > rank[worst]) worst = level;
    el.className = `tag ${level}`;
    let ins = inspection[id];
    if (ins?.ok && s.seen.length >= 30 && rate < 90) {
      ins = { ...ins, ok: false, nWrong: 0,
        diag: mod * scale > 6
          ? 'Pattern is fine; squares are too big for the detector. Set Detect at to Auto or a smaller size'
          : 'Pattern is fine, but the outline keeps getting lost: check glare and focus on this tag' };
    }
    el.querySelector('.diag').innerHTML = !fit ? 'Waiting for a sheet fit' : !ins ? '…' :
      span(ins.ok ? 'ok' : ins.nWrong > 0 || ins.contrast < 50 ? 'no' : 'mid', ins.diag) +
      (ins.contrast != null ? ` <span class="k">· contrast ${ins.contrast.toFixed(0)}</span>` : '');
    el.querySelector('.info').innerHTML =
      `<b>Tag ${id}</b><br>` +
      `<span class="k">read</span> ${span(g[0], rate + '%')} <span class="k">exact</span> ${span(g[1], exact + '%')}<br>` +
      `<span class="k">px/sq</span> ${s.side ? mod.toFixed(1) : '—'} <span class="k">det</span> ${s.side ? span(g[2], detMod.toFixed(1)) : '—'}<br>` +
      `<span class="k">jitter</span> ${jit == null ? '—' : span(g[3], jit.toFixed(2) + 'px')}`;
  }

  // Judge the fit on the paper, not in camera pixels: corner precision depends on the detect scale.
  const fitIn = fit ? fit.max / fit.pxPerIn : null;
  const fitG = fit ? grade(fitIn, 0.1, 0.25, false) : 'no';
  if (!fit || fit.n < 4) worst = 'bad';
  else if (fitG !== 'ok' && worst === 'good') worst = 'warn';
  const tokenMod = fit ? (fit.pxPerIn * 0.75) / 6 : null; // a 0.75" token is 6 modules of 1/8"
  const v = $('#verdict');
  v.className = `verdict ${worst === 'good' ? 'ok' : worst === 'warn' ? 'mid' : 'no'}`;
  v.textContent = worst === 'good' ? 'Ready: all four tags read cleanly'
    : !fit || fit.n < 4 ? `Need all four tags in view (${fit?.n ?? 0}/4 exact)` : 'Usable, but some numbers are marginal';

  const rows = [
    ['Camera', `${vw}×${vh}`],
    ['Detecting at', `${grab.width}×${grab.height} (${Math.round(scale * 100)}%${autoScale ? ', auto' : ''})`],
    ['Speed', `${fps.toFixed(0)} fps · ${detMs.toFixed(0)} ms`],
    ['Tags in fit', fit ? `${fit.n}/4` : '—'],
    ['Fit error', fit ? `${span(fitG, fitIn.toFixed(2) + '″ max')} · ${fit.max.toFixed(1)} px, ${fit.rms.toFixed(1)} rms` : '—'],
    ['Sheet resolution', fit ? `${fit.pxPerIn.toFixed(0)} px/in` : '—'],
    ['Sheet fills frame', fit ? `${span(grade(fit.coverage * 100, 45, 25), Math.round(fit.coverage * 100) + '%')}` : '—'],
    ['0.75″ token would be', tokenMod ? span(grade(tokenMod, 4, 3), tokenMod.toFixed(1) + ' camera px/square') : '—'],
    ['Stray reads', `${strays} in ${frames} frames`],
  ];
  $('#overall').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
  const dots = IDS.map((id) => (lastMarkers.some((m) => m.id === id && m.exact) ? '●' : '○')).join('');
  $('#status').textContent = `Tags ${dots}`;
}

// ---------- camera controls ----------

const RANGES = [
  ['zoom', 'Zoom'], ['focusDistance', 'Focus'], ['exposureTime', 'Exposure'], ['exposureCompensation', 'Exp. comp.'],
  ['iso', 'ISO'], ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['sharpness', 'Sharpness'],
  ['saturation', 'Saturation'], ['colorTemperature', 'White bal.'],
];
// Setting these only sticks when the matching mode is manual.
const NEEDS = { focusDistance: 'focusMode', exposureTime: 'exposureMode', iso: 'exposureMode', colorTemperature: 'whiteBalanceMode' };

function buildControls() {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() || {}, cur = track?.getSettings?.() || {};
  const box = $('#ctls');
  box.replaceChildren();
  const avail = RANGES.filter(([k]) => caps[k] && typeof caps[k].min === 'number' && caps[k].max > caps[k].min);
  if (!avail.length) {
    box.innerHTML = '<span class="note" style="grid-column:1/-1">This browser or camera doesn’t expose any adjustable settings. Chrome on a USB webcam usually does; Safari and most built-in Mac cameras don’t.</span>';
    return;
  }
  for (const [k, label] of avail) {
    const { min, max, step } = caps[k];
    const lab = document.createElement('label'); lab.textContent = label;
    const r = Object.assign(document.createElement('input'), { type: 'range', min, max, step: step || (max - min) / 100, value: cur[k] ?? min });
    const out = document.createElement('output'); out.value = fmt(r.value);
    r.oninput = async () => {
      out.value = fmt(r.value);
      const c = { [k]: Number(r.value) };
      if (NEEDS[k] && caps[NEEDS[k]]?.includes('manual')) c[NEEDS[k]] = 'manual';
      try { await track.applyConstraints({ advanced: [c] }); stats = freshStats(); } catch (e) { out.value = 'n/a'; }
    };
    box.append(lab, r, out);
  }
}
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v).toFixed(Number(v) % 1 ? 2 : 0));

async function setModes(mode) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {}, adv = {};
  for (const k of ['focusMode', 'exposureMode', 'whiteBalanceMode']) if (caps[k]?.includes(mode)) adv[k] = mode;
  if (!Object.keys(adv).length) { $('#status').textContent = `This camera can’t switch to ${mode} here`; return; }
  try {
    await track.applyConstraints({ advanced: [adv] });
    $('#status').textContent = `Set ${Object.keys(adv).map((k) => k.replace('Mode', '')).join(', ')} to ${mode}`;
    stats = freshStats();
    buildControls();
  } catch (e) { $('#status').textContent = `Couldn’t set ${mode}: ${e.message}`; }
}

// ---------- snapshot ----------

function snapshot() {
  if (!stream) return;
  const c = document.createElement('canvas');
  c.width = overlay.width; c.height = overlay.height;
  const x = c.getContext('2d');
  x.drawImage(video, 0, 0, c.width, c.height);
  x.drawImage(overlay, 0, 0);
  const a = document.createElement('a');
  a.download = `aruco-calibration-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

// ---------- wiring ----------

$('#start').onclick = () => (stream ? stop() : start());
$('#camSelect').onchange = () => stream && start();
$('#res').onchange = () => { store.set('res', $('#res').value); if (stream) start(); };
$('#scale').onchange = () => { applyScaleSetting(); store.set('detectScale', $('#scale').value); stats = freshStats(); };
$('#reset').onclick = () => { stats = freshStats(); };
$('#snap').onclick = snapshot;
$('#lock').onclick = () => setModes('manual');
$('#unlock').onclick = () => setModes('continuous');
$('#showGray').onchange = () => { grayFrame = null; };
for (const el of document.querySelectorAll('.tag')) {
  el.innerHTML = `<canvas width="${CROP}" height="${CROP}" title="What the camera sees where this tag should be. Red = square read wrong."></canvas><div class="info"></div><div class="diag"></div>`;
}
listCameras().catch(() => {});
render();
