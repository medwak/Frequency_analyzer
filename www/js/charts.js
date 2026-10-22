// Canvas chart helpers. Every chart reads its colours from CSS custom
// properties so light and dark themes work without extra code.

import { VOWELS, NOTE_NAMES, formatFrequency } from './dsp.js';

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Sizes the backing store for the device pixel ratio. The canvas height
// attribute in the HTML is treated as its CSS height.
export function setup(canvas) {
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute('height');
  const cssH = Number(canvas.dataset.h);
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return { ctx, w: cssW, h: cssH };
}

const PAD = { l: 34, r: 8, t: 8, b: 20 };

export const logScale = (v, min, max, a, b) => a + ((Math.log(v / min) / Math.log(max / min)) * (b - a));
export const invLogScale = (p, min, max, a, b) => min * Math.pow(max / min, (p - a) / (b - a));

function freqLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

function drawFreqAxis(ctx, w, h, fMin, fMax) {
  ctx.strokeStyle = cssVar('--grid');
  ctx.fillStyle = cssVar('--text-3');
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f < fMin || f > fMax) continue;
    const x = logScale(f, fMin, fMax, PAD.l, w - PAD.r);
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, h - PAD.b);
    ctx.stroke();
    ctx.fillText(freqLabel(f), x, h - PAD.b + 5);
  }
}

function drawDbAxis(ctx, w, h, dbMin, dbMax, step) {
  ctx.strokeStyle = cssVar('--grid');
  ctx.fillStyle = cssVar('--text-3');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let db = Math.ceil(dbMin / step) * step; db <= dbMax; db += step) {
    const y = PAD.t + ((dbMax - db) / (dbMax - dbMin)) * (h - PAD.t - PAD.b);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(w - PAD.r, y);
    ctx.stroke();
    ctx.fillText(`${db}`, PAD.l - 6, y);
  }
}

// Live spectrum from AnalyserNode dB data.
export function drawSpectrum(canvas, db, sampleRate, f0) {
  const { ctx, w, h } = setup(canvas);
  const fMin = 40;
  const fMax = Math.min(12000, sampleRate / 2);
  const dbMin = -100;
  const dbMax = -10;
  drawDbAxis(ctx, w, h, dbMin, dbMax, 30);
  drawFreqAxis(ctx, w, h, fMin, fMax);
  if (!db) return;
  const binHz = sampleRate / 2 / db.length;
  const y = (v) => PAD.t + ((dbMax - Math.max(dbMin, Math.min(dbMax, v))) / (dbMax - dbMin)) * (h - PAD.t - PAD.b);
  // Take the max of all bins under each pixel so narrow peaks survive.
  ctx.beginPath();
  let started = false;
  for (let x = PAD.l; x <= w - PAD.r; x++) {
    const f1 = invLogScale(x, fMin, fMax, PAD.l, w - PAD.r);
    const f2 = invLogScale(x + 1, fMin, fMax, PAD.l, w - PAD.r);
    const b1 = Math.floor(f1 / binHz);
    const b2 = Math.max(b1, Math.floor(f2 / binHz));
    let m = -Infinity;
    for (let b = b1; b <= b2 && b < db.length; b++) if (db[b] > m) m = db[b];
    if (!isFinite(m)) m = dbMin;
    if (!started) { ctx.moveTo(x, y(m)); started = true; } else ctx.lineTo(x, y(m));
  }
  const accent = cssVar('--series-1');
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w - PAD.r, h - PAD.b);
  ctx.lineTo(PAD.l, h - PAD.b);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (f0 > fMin && f0 < fMax) {
    ctx.strokeStyle = cssVar('--text');
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    for (let k = 1; k <= 8 && f0 * k < fMax; k++) {
      const x = logScale(f0 * k, fMin, fMax, PAD.l, w - PAD.r);
      ctx.globalAlpha = k === 1 ? 0.9 : 0.3;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, h - PAD.b);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
}

// Horizontal lines at every C (labelled) on a log-frequency y axis.
function drawNoteGrid(ctx, w, h, fMin, fMax, a4) {
  ctx.strokeStyle = cssVar('--grid');
  ctx.fillStyle = cssVar('--text-3');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  const midiMin = Math.ceil(69 + 12 * Math.log2(fMin / a4));
  const midiMax = Math.floor(69 + 12 * Math.log2(fMax / a4));
  const span = midiMax - midiMin;
  for (let m = midiMin; m <= midiMax; m++) {
    const pc = ((m % 12) + 12) % 12;
    const label = pc === 0 || (span < 14 && (pc === 4 || pc === 7)) || (span < 8);
    if (!label) continue;
    const f = a4 * Math.pow(2, (m - 69) / 12);
    const y = logScale(f, fMin, fMax, h - PAD.b, PAD.t);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(w - PAD.r, y);
    ctx.stroke();
    ctx.fillText(`${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`, PAD.l - 6, y);
  }
}

// Scrolling pitch history: points = [{ t, f }] with t in ms.
export function drawPitchHistory(canvas, points, now, spanMs, a4) {
  const { ctx, w, h } = setup(canvas);
  const voiced = points.filter((p) => p.f > 0);
  let fMin = 80;
  let fMax = 800;
  if (voiced.length) {
    const lo = Math.min(...voiced.map((p) => p.f));
    const hi = Math.max(...voiced.map((p) => p.f));
    fMin = Math.max(30, Math.min(fMin, lo / 1.25));
    fMax = Math.min(5000, Math.max(fMax, hi * 1.25));
  }
  drawNoteGrid(ctx, w, h, fMin, fMax, a4);
  ctx.fillStyle = cssVar('--text-3');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = 0; s <= spanMs / 1000; s += 2) {
    const x = w - PAD.r - (s * 1000 / spanMs) * (w - PAD.l - PAD.r);
    ctx.fillText(s === 0 ? 'now' : `−${s}s`, x, h - PAD.b + 5);
  }
  ctx.strokeStyle = cssVar('--series-1');
  ctx.lineWidth = 2;
  ctx.beginPath();
  let prev = null;
  for (const p of points) {
    const x = w - PAD.r - ((now - p.t) / spanMs) * (w - PAD.l - PAD.r);
    if (x < PAD.l || !(p.f > 0)) { prev = null; continue; }
    const y = logScale(p.f, fMin, fMax, h - PAD.b, PAD.t);
    if (prev && p.t - prev.t < 120) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    prev = p;
  }
  ctx.stroke();
}

// Classic phonetic vowel chart: F2 right-to-left, F1 top-to-bottom.
export function drawVowelChart(canvas, f1, f2, trail = []) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 34, r: 12, t: 10, b: 22 };
  const f2Min = 600, f2Max = 2800, f1Min = 200, f1Max = 1000;
  const X = (v) => logScale(Math.min(f2Max, Math.max(f2Min, v)), f2Max, f2Min, pad.l, w - pad.r);
  const Y = (v) => logScale(Math.min(f1Max, Math.max(f1Min, v)), f1Min, f1Max, pad.t, h - pad.b);
  ctx.strokeStyle = cssVar('--grid');
  ctx.fillStyle = cssVar('--text-3');
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of [800, 1000, 1500, 2000, 2500]) {
    const x = X(v);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.fillText(freqLabel(v), x, h - pad.b + 5);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [300, 500, 700, 900]) {
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(`${v}`, pad.l - 6, y);
  }

  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cssVar('--text-2');
  for (const v of VOWELS) ctx.fillText(v.ipa, X(v.f2), Y(v.f1));

  const color = cssVar('--series-2');
  trail.forEach((p, i) => {
    ctx.globalAlpha = 0.08 + (0.3 * i) / Math.max(1, trail.length);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(X(p.f2), Y(p.f1), 4, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;
  if (f1 > 0 && f2 > 0) {
    ctx.fillStyle = color;
    ctx.strokeStyle = cssVar('--surface');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(f2), Y(f1), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

export function renderHarmonics(el, list) {
  if (!list || !list.length) {
    el.className = 'harmonics empty';
    el.textContent = 'No clear pitch';
    return;
  }
  el.className = 'harmonics';
  el.innerHTML = '';
  for (const hm of list) {
    const d = document.createElement('div');
    d.className = 'h';
    const pct = Math.max(2, 100 * (1 + hm.db / 60));
    d.title = `Harmonic ${hm.n}: ${formatFrequency(hm.frequency)}, ${hm.db.toFixed(0)} dB`;
    d.innerHTML = `<div class="bar" style="height:${Math.min(100, pct) * 0.72}%"></div><div class="lbl">${hm.n === 1 ? 'f₀' : `${hm.n}×`}</div>`;
    el.appendChild(d);
  }
}

// ------------------------------------------------- file-result charts

function parseHex(hex) {
  const m = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
}

function rampColor(stops, t) {
  const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

const imageCache = new WeakMap();

function spectrogramImage(spec) {
  const key = spec;
  const theme = cssVar('--spec-0') + cssVar('--spec-3');
  const cached = imageCache.get(key);
  if (cached && cached.theme === theme) return cached.canvas;
  const stops = ['--spec-0', '--spec-1', '--spec-2', '--spec-3'].map((v) => parseHex(cssVar(v)));
  const off = document.createElement('canvas');
  off.width = spec.cols;
  off.height = spec.rows;
  const octx = off.getContext('2d');
  const img = octx.createImageData(spec.cols, spec.rows);
  const floor = -70;
  for (let c = 0; c < spec.cols; c++) {
    for (let r = 0; r < spec.rows; r++) {
      const db = spec.data[c * spec.rows + r];
      const [R, G, B] = rampColor(stops, (db - floor) / -floor);
      const p = ((spec.rows - 1 - r) * spec.cols + c) * 4;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  imageCache.set(key, { theme, canvas: off });
  return off;
}

export function drawSpectrogram(canvas, spec, duration, playhead, marker) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 34, r: 8, t: 4, b: 20 };
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(spectrogramImage(spec), pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.fillStyle = cssVar('--text-3');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const f of [100, 500, 1000, 2000, 5000, 10000]) {
    if (f < spec.fMin || f > spec.fMax) continue;
    ctx.fillText(freqLabel(f), pad.l - 6, logScale(f, spec.fMin, spec.fMax, h - pad.b, pad.t));
  }
  timeAxis(ctx, w, h, pad, duration);
  if (playhead >= 0) drawPlayhead(ctx, pad.l + playhead * (w - pad.l - pad.r), pad.t, h - pad.b);
  if (marker) {
    ctx.strokeStyle = cssVar('--text');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2); ctx.stroke();
  }
  return pad;
}

function timeAxis(ctx, w, h, pad, duration) {
  ctx.fillStyle = cssVar('--text-3');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const steps = [1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => duration / s <= 6) || 300;
  for (let t = 0; t <= duration; t += step) {
    const x = pad.l + (t / duration) * (w - pad.l - pad.r);
    ctx.fillText(formatTime(t), Math.min(w - 14, Math.max(pad.l + 8, x)), h - pad.b + 5);
  }
}

function drawPlayhead(ctx, x, top, bottom) {
  ctx.strokeStyle = cssVar('--text');
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
}

export function drawContour(canvas, track, duration, a4, playhead) {
  const { ctx, w, h } = setup(canvas);
  const voiced = [];
  for (const f of track.freqs) if (f > 0) voiced.push(f);
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  if (!voiced.length) {
    ctx.fillStyle = cssVar('--text-3');
    ctx.textAlign = 'center';
    ctx.fillText('No sung or spoken pitch found', w / 2, h / 2);
    return;
  }
  voiced.sort((a, b) => a - b);
  const lo = voiced[Math.floor(voiced.length * 0.01)];
  const hi = voiced[Math.floor(voiced.length * 0.99)];
  const fMin = Math.max(40, lo / 1.15);
  const fMax = Math.max(fMin * 1.5, hi * 1.15);
  drawNoteGrid(ctx, w, h, fMin, fMax, a4);
  timeAxis(ctx, w, h, pad, duration);
  ctx.strokeStyle = cssVar('--series-2');
  ctx.lineWidth = 2;
  ctx.beginPath();
  let gap = true;
  for (let i = 0; i < track.times.length; i++) {
    const f = track.freqs[i];
    if (!(f > 0) || f < fMin || f > fMax) { gap = true; continue; }
    const x = pad.l + (track.times[i] / duration) * (w - pad.l - pad.r);
    const y = logScale(f, fMin, fMax, h - pad.b, pad.t);
    if (gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    gap = false;
  }
  ctx.stroke();
  if (playhead >= 0) drawPlayhead(ctx, pad.l + playhead * (w - pad.l - pad.r), pad.t, h - pad.b);
}

const peaksCache = new WeakMap();

export function drawWaveform(canvas, samples, colorVar, playhead) {
  const { ctx, w, h } = setup(canvas);
  const cols = Math.max(1, Math.floor(w / 3));
  let peaks = peaksCache.get(samples);
  if (!peaks || peaks.length !== cols) {
    peaks = new Float32Array(cols);
    const per = samples.length / cols;
    let max = 1e-9;
    for (let c = 0; c < cols; c++) {
      let m = 0;
      const s0 = Math.floor(c * per);
      const s1 = Math.floor((c + 1) * per);
      for (let i = s0; i < s1; i += 4) { const a = Math.abs(samples[i]); if (a > m) m = a; }
      peaks[c] = m;
      if (m > max) max = m;
    }
    for (let c = 0; c < cols; c++) peaks[c] /= max;
    peaksCache.set(samples, peaks);
  }
  ctx.fillStyle = cssVar(colorVar);
  const mid = h / 2;
  const split = playhead >= 0 ? playhead * w : Infinity;
  for (let c = 0; c < cols; c++) {
    const x = c * 3;
    const ph = Math.max(1, peaks[c] * (h / 2 - 2));
    // Already-played part at full strength, the rest faded.
    ctx.globalAlpha = x <= split ? 1 : 0.35;
    ctx.fillRect(x, mid - ph, 2, ph * 2);
  }
  ctx.globalAlpha = 1;
  if (playhead >= 0) drawPlayhead(ctx, playhead * w, 0, h);
}

export function drawAverageSpectrum(canvas, avg, hoverX) {
  const { ctx, w, h } = setup(canvas);
  const fMin = avg.freqs[0];
  const fMax = avg.freqs[avg.freqs.length - 1];
  const dbMin = -80;
  const dbMax = 0;
  drawDbAxis(ctx, w, h, dbMin, dbMax, 20);
  drawFreqAxis(ctx, w, h, fMin, fMax);
  const Y = (v) => PAD.t + ((dbMax - Math.max(dbMin, v)) / (dbMax - dbMin)) * (h - PAD.t - PAD.b);
  const X = (f) => logScale(f, fMin, fMax, PAD.l, w - PAD.r);
  for (const [key, colorVar] of [['mix', '--series-1'], ['inst', '--series-3'], ['vocal', '--series-2']]) {
    ctx.strokeStyle = cssVar(colorVar);
    ctx.lineWidth = 2;
    ctx.beginPath();
    avg[key].forEach((v, i) => (i ? ctx.lineTo(X(avg.freqs[i]), Y(v)) : ctx.moveTo(X(avg.freqs[i]), Y(v))));
    ctx.stroke();
  }
  if (hoverX != null) {
    const x = Math.max(PAD.l, Math.min(w - PAD.r, hoverX));
    ctx.strokeStyle = cssVar('--text-3');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke();
  }
  return { fMin, fMax, pad: PAD };
}

export function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
