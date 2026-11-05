// Camera + ArUco + sheet calibration for the 11 × 17 portrait sheet.
// Reports token positions in sheet pixels (300 DPI). Uses detector.worker.js (DICT_4X4_50).
import { homography, applyH } from './core.js';

export const SHEET = {
  w: 3300, h: 5100, dpi: 300, tag: 300,
  tags: { 0: [75, 75], 1: [2925, 75], 2: [2925, 4725], 3: [75, 4725] }, // top-left of each corner tag
};
export const CORNER_IDS = [0, 1, 2, 3];

// js-aruco loses tag outlines when squares are big, so detect on a shrunk copy (see calibrate.js).
const TARGET_MOD = 4.5;   // detector px per square for corner tags (0.75" tokens then get ~3.4)
const SCALES = [1, 0.6, 0.4, 0.25];
const SMOOTHING = 0.3, MOVE_FRAMES = 6;

export function quadArea(c) {
  let a = 0;
  for (let i = 0, j = 3; i < 4; j = i++) a += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
  return Math.abs(a / 2);
}
export const center = (c) => c.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
function tagCorners(id) {
  const [x, y] = SHEET.tags[id], t = SHEET.tag;
  return [[x, y], [x + t, y], [x + t, y + t], [x, y + t]];
}

export class SheetCam {
  constructor(video, onFrame) {
    this.video = video;
    this.onFrame = onFrame;
    this.grab = document.createElement('canvas');
    this.gctx = this.grab.getContext('2d', { willReadFrequently: true });
    this.worker = new Worker('detector.worker.js');
    this.worker.onmessage = ({ data }) => this._result(data);
    this.stream = null; this.busy = false;
    this.scale = 0.5; this.sentScale = 0.5; this.miss = 0; this.sweep = 0;
    this.anchors = {}; this.fit = null; this.markers = []; this.fps = 0; this.lastAt = 0;
  }

  static async cameras() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }

  async start(deviceId, width = 1920, height = 1080) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: width }, height: { ideal: height }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.anchors = {}; this.fit = null;
    const loop = () => { if (this.stream) { this._grab(); requestAnimationFrame(loop); } };
    requestAnimationFrame(loop);
    return this.stream.getVideoTracks()[0].getSettings().deviceId;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.busy = false; this.markers = [];
  }

  recalibrate() { this.anchors = {}; this.fit = null; }

  _grab() {
    const v = this.video;
    if (this.busy || v.readyState < 2 || !v.videoWidth) return;
    const w = Math.round(v.videoWidth * this.scale), h = Math.round(v.videoHeight * this.scale);
    if (this.grab.width !== w || this.grab.height !== h) { this.grab.width = w; this.grab.height = h; }
    this.gctx.drawImage(v, 0, 0, w, h);
    const img = this.gctx.getImageData(0, 0, w, h);
    this.busy = true;
    this.sentScale = this.scale;
    this.worker.postMessage({ w, h, buffer: img.data.buffer }, [img.data.buffer]);
  }

  _result(data) {
    this.busy = false;
    if (!this.stream) return;
    const now = performance.now();
    this.fps = this.fps * 0.85 + (1000 / Math.max(1, now - this.lastAt)) * 0.15;
    this.lastAt = now;
    const s = this.sentScale;
    this.markers = data.markers.map((m) => ({ ...m, corners: m.corners.map(([x, y]) => [x / s, y / s]) }));

    for (const m of this.markers) if (CORNER_IDS.includes(m.id) && m.exact) this._track(m);
    this._fit();
    this._autoscale();

    const tokens = !this.fit ? [] : this.markers
      .filter((m) => !CORNER_IDS.includes(m.id))
      .map((m) => ({ id: m.id, cam: center(m.corners), pt: applyH(this.fit.toSheet, center(m.corners)), exact: m.exact }));
    this.onFrame({ tokens, markers: this.markers, fit: this.fit });
  }

  // Corner tags don't move, so each keeps a smoothed position; a covered tag keeps its last one.
  _track(m) {
    const a = this.anchors[m.id];
    if (!a) { this.anchors[m.id] = { pts: m.corners.map((p) => [...p]), moved: 0 }; return; }
    const side = Math.sqrt(quadArea(a.pts));
    const dist = Math.max(...m.corners.map((p, i) => Math.hypot(p[0] - a.pts[i][0], p[1] - a.pts[i][1])));
    if (dist < side * 0.12) {
      a.moved = 0;
      a.pts = a.pts.map((p, i) => [p[0] + (m.corners[i][0] - p[0]) * SMOOTHING, p[1] + (m.corners[i][1] - p[1]) * SMOOTHING]);
    } else if (++a.moved >= MOVE_FRAMES) { a.pts = m.corners.map((p) => [...p]); a.moved = 0; }
  }

  _fit() {
    const ids = Object.keys(this.anchors);
    if (ids.length < 2) return; // keep the last fit
    const cam = [], sheet = [];
    for (const id of ids) tagCorners(id).forEach((p, i) => { sheet.push(p); cam.push(this.anchors[id].pts[i]); });
    const toCam = homography(sheet, cam), toSheet = homography(cam, sheet);
    if (toCam && toSheet) this.fit = { toCam, toSheet, tags: ids.length };
  }

  _autoscale() {
    const mods = this.markers.filter((m) => CORNER_IDS.includes(m.id)).map((m) => Math.sqrt(quadArea(m.corners)) / 6);
    if (mods.length) {
      this.miss = 0;
      const mod = mods.sort((a, b) => a - b)[mods.length >> 1];
      const want = Math.min(1, Math.max(0.2, TARGET_MOD / mod));
      if (Math.abs(want - this.scale) / this.scale > 0.15) this.scale = want;
    } else if (++this.miss >= 8) { this.miss = 0; this.scale = SCALES[this.sweep++ % SCALES.length]; }
  }
}
