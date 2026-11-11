// Runs ArUco detection off the main thread so the map stays smooth.
importScripts('vendor/cv.js', 'vendor/aruco.js', 'vendor/aruco_4x4_1000.js');

// OpenCV's DICT_4X4_50 is the first 50 codes of ARUCO_4X4_1000 (verified against
// markers from tools/generate_markers.py). Matching against only those 50 stops plan
// details (tables, elevator squares) from being read as a stray code.
AR.DICTIONARIES.DICT_4X4_50 = {
  nBits: 16,
  codeList: AR.DICTIONARIES.ARUCO_4X4_1000.codeList.slice(0, 50),
};
// tau 2 = accept at most 1 wrong bit; the main thread only calibrates from exact reads.
const detector = new AR.Detector({ dictionaryName: 'DICT_4X4_50', maxHammingDistance: 2 });

function area(c) {
  let a = 0;
  for (let i = 0, j = 3; i < 4; j = i++) a += (c[j].x + c[i].x) * (c[j].y - c[i].y);
  return Math.abs(a / 2);
}

self.onmessage = ({ data }) => {
  const t0 = performance.now();
  const found = detector.detectImage(data.w, data.h, new Uint8ClampedArray(data.buffer));

  // One read per ID: prefer the exact match, then the biggest.
  const best = new Map();
  for (const m of found) {
    const prev = best.get(m.id);
    if (!prev || m.hammingDistance < prev.hammingDistance ||
        (m.hammingDistance === prev.hammingDistance && area(m.corners) > area(prev.corners))) best.set(m.id, m);
  }
  const markers = [...best.values()].map((m) => ({
    id: m.id,
    exact: m.hammingDistance === 0,
    corners: m.corners.map((p) => [p.x, p.y]),
  }));
  self.postMessage({ markers, ms: performance.now() - t0 });
};
