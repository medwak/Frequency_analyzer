// Core signal-processing routines shared by the live analyser, the file
// worker and the unit tests. Pure functions only: no DOM, no Web Audio.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Speed of sound in dry air (m/s) at a given temperature in °C.
export function speedOfSound(tempC = 20) {
  return 331.3 + 0.606 * tempC;
}

export function wavelength(freq, tempC = 20) {
  return freq > 0 ? speedOfSound(tempC) / freq : NaN;
}

export function frequencyToNote(freq, a4 = 440) {
  if (!(freq > 0)) return null;
  const midiFloat = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { midi, name, octave, cents, label: `${name}${octave}`, exact: a4 * Math.pow(2, (midi - 69) / 12) };
}

export function formatFrequency(f) {
  if (!(f > 0)) return '—';
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`;
}

export function formatLength(m) {
  if (!(m > 0)) return '—';
  if (m >= 1) return `${m.toFixed(2)} m`;
  if (m >= 0.01) return `${(m * 100).toFixed(1)} cm`;
  return `${(m * 1000).toFixed(1)} mm`;
}

// ---------------------------------------------------------------- FFT

// In-place iterative radix-2 complex FFT. Length must be a power of two.
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function hamming(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// Magnitude spectrum (linear) of a real frame, Hann-windowed, zero-padded to size.
export function magnitudeSpectrum(frame, size = nextPow2(frame.length)) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const w = hann(frame.length);
  for (let i = 0; i < frame.length; i++) re[i] = frame[i] * w[i];
  fft(re, im);
  const mag = new Float32Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function rms(buf, start = 0, end = buf.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function toDb(x, floor = -120) {
  return x > 0 ? Math.max(floor, 20 * Math.log10(x)) : floor;
}

// ------------------------------------------------------- resampling

// Windowed-sinc low-pass followed by integer decimation.
export function lowpassDecimate(x, factor) {
  if (factor <= 1) return Float32Array.from(x);
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.45 / factor;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - half;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const outLen = Math.floor(x.length / factor);
  const y = new Float32Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = o * factor;
    let acc = 0;
    const lo = Math.max(0, c - half);
    const hi = Math.min(x.length - 1, c + half);
    for (let i = lo; i <= hi; i++) acc += x[i] * h[i - c + half];
    y[o] = acc;
  }
  return y;
}

// ------------------------------------------------------------ pitch

// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002).
// Returns { frequency, clarity } or null when no periodicity is found.
export function yin(buf, sampleRate, opts = {}) {
  const { minFreq = 50, maxFreq = 1500, threshold = 0.15 } = opts;
  const n = buf.length;
  const maxTau = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  if (maxTau <= minTau + 2) return null;
  const w = n - maxTau;
  const d = new Float32Array(maxTau + 2);
  for (let tau = 1; tau <= maxTau + 1 && tau < n - w + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = buf[j] - buf[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  const cmnd = new Float32Array(maxTau + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau + 1; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // No dip under the threshold: accept the global minimum only if it is
    // still reasonably periodic.
    let best = minTau;
    for (let t = minTau; t <= maxTau; t++) if (cmnd[t] < cmnd[best]) best = t;
    if (cmnd[best] > 0.35) return null;
    tau = best;
  }
  let refined = tau;
  if (tau > 1 && tau < maxTau + 1) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) refined = tau + (0.5 * (a - c)) / denom;
  }
  return { frequency: sampleRate / refined, clarity: Math.max(0, Math.min(1, 1 - cmnd[tau])) };
}

// Amplitude (dB relative to strongest) of the first `count` harmonics of f0.
export function harmonics(mag, sampleRate, fftSize, f0, count = 8) {
  const out = [];
  const binHz = sampleRate / fftSize;
  for (let k = 1; k <= count; k++) {
    const f = f0 * k;
    if (f >= sampleRate / 2) break;
    const lo = Math.max(1, Math.floor((f * 0.97) / binHz));
    const hi = Math.min(mag.length - 1, Math.ceil((f * 1.03) / binHz));
    let peak = 0;
    for (let b = lo; b <= hi; b++) if (mag[b] > peak) peak = mag[b];
    out.push({ n: k, frequency: f, amp: peak });
  }
  const max = Math.max(1e-12, ...out.map((h) => h.amp));
  for (const h of out) h.db = toDb(h.amp / max, -80);
  return out;
}

// ----------------------------------------------------- formants / LPC

function levinson(r, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  if (err <= 0) return null;
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return null;
  }
  return a;
}

// Estimates the first three formants from the peaks of the LPC envelope.
export function formants(buf, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const x = lowpassDecimate(buf, factor);
  const sr = sampleRate / factor;
  const n = x.length;
  if (n < 256) return null;
  const w = hamming(n);
  const y = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    y[i] = (x[i] - 0.9 * prev) * w[i];
    prev = x[i];
  }
  const order = 2 + Math.round(sr / 1000);
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += y[i] * y[i - lag];
    r[lag] = s;
  }
  r[0] *= 1 + 1e-9; // tiny white-noise floor for numerical stability
  const a = levinson(r, order);
  if (!a) return null;
  const points = 512;
  const env = new Float64Array(points);
  for (let p = 0; p < points; p++) {
    const omega = (Math.PI * p) / points;
    let re = 0;
    let im = 0;
    for (let k = 0; k <= order; k++) {
      re += a[k] * Math.cos(omega * k);
      im -= a[k] * Math.sin(omega * k);
    }
    env[p] = -10 * Math.log10(re * re + im * im + 1e-20);
  }
  const peaks = [];
  for (let p = 1; p < points - 1; p++) {
    if (env[p] > env[p - 1] && env[p] >= env[p + 1]) {
      const den = env[p - 1] - 2 * env[p] + env[p + 1];
      const off = den !== 0 ? (0.5 * (env[p - 1] - env[p + 1])) / den : 0;
      const f = ((p + off) * sr) / 2 / points;
      if (f > 200 && f < sr / 2 - 200) peaks.push(f);
    }
  }
  const f1 = peaks.find((f) => f >= 200 && f <= 1100);
  if (!f1) return null;
  const f2 = peaks.find((f) => f > f1 + 150 && f >= 550 && f <= 3200);
  const f3 = f2 ? peaks.find((f) => f > f2 + 200 && f <= 4500) : undefined;
  return { f1, f2: f2 ?? NaN, f3: f3 ?? NaN };
}

// Average adult formant targets (Hz) for common vowels.
export const VOWELS = [
  { ipa: 'i', label: 'ee (as in "see")', f1: 300, f2: 2400 },
  { ipa: 'e', label: 'ay (as in "say")', f1: 450, f2: 2100 },
  { ipa: 'ɛ', label: 'eh (as in "bed")', f1: 600, f2: 1850 },
  { ipa: 'a', label: 'ah (as in "father")', f1: 780, f2: 1300 },
  { ipa: 'ʌ', label: 'uh (as in "cup")', f1: 650, f2: 1200 },
  { ipa: 'ɔ', label: 'aw (as in "law")', f1: 590, f2: 900 },
  { ipa: 'o', label: 'oh (as in "go")', f1: 450, f2: 850 },
  { ipa: 'u', label: 'oo (as in "food")', f1: 320, f2: 850 },
];

export function classifyVowel(f1, f2) {
  if (!(f1 > 0) || !(f2 > 0)) return null;
  let best = null;
  let second = Infinity;
  for (const v of VOWELS) {
    const d = Math.hypot(Math.log(f1 / v.f1), 0.7 * Math.log(f2 / v.f2));
    if (!best || d < best.distance) {
      if (best) second = best.distance;
      best = { ...v, distance: d };
    } else if (d < second) {
      second = d;
    }
  }
  // Confidence: how clearly the best match beats the runner-up, scaled down
  // when the measured formants are far from any vowel target.
  const margin = Math.min(1, (second - best.distance) / 0.25);
  best.confidence = Math.max(0, Math.min(1, margin * Math.exp(-best.distance * 2)));
  return best;
}

// ------------------------------------------------------- statistics

export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

// Median of `len` values in a scratch buffer (insertion sort; len is small).
function smallMedian(scratch, len) {
  for (let i = 1; i < len; i++) {
    const v = scratch[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
    scratch[j + 1] = v;
  }
  return scratch[len >> 1];
}

// Swaps `oldV` for `newV` in the sorted run arr[off, off + len) in O(len),
// which makes running medians far cheaper than re-sorting every window.
function sortedReplace(arr, off, len, oldV, newV) {
  const end = off + len;
  let i = off;
  while (i < end - 1 && arr[i] !== oldV) i++;
  if (newV > oldV) {
    while (i + 1 < end && arr[i + 1] < newV) { arr[i] = arr[i + 1]; i++; }
  } else {
    while (i > off && arr[i - 1] > newV) { arr[i] = arr[i - 1]; i--; }
  }
  arr[i] = newV;
}

export function voiceType(medianHz) {
  if (!(medianHz > 0)) return null;
  if (medianHz < 120) return 'Bass';
  if (medianHz < 155) return 'Baritone';
  if (medianHz < 200) return 'Tenor';
  if (medianHz < 260) return 'Alto / Contralto';
  if (medianHz < 330) return 'Mezzo-soprano';
  return 'Soprano';
}

// --------------------------------------------------------- music

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Krumhansl–Schmuckler key estimate from a 12-bin chroma vector (C first).
export function estimateKey(chroma) {
  let best = { score: -Infinity };
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      const score = correlation(chroma, rotated);
      scores.push(score);
      if (score > best.score) best = { tonic, mode, score, name: `${NOTE_NAMES[tonic]} ${mode}` };
    }
  }
  scores.sort((x, y) => y - x);
  best.confidence = Math.max(0, Math.min(1, (scores[0] - scores[1]) * 5 + Math.max(0, scores[0]) * 0.5));
  return best;
}

// Tempo (BPM) from an onset-strength envelope sampled at `rate` frames/s.
export function estimateTempo(onset, rate, minBpm = 60, maxBpm = 200) {
  const n = onset.length;
  if (n < rate * 4) return null;
  const mean = onset.reduce((s, v) => s + v, 0) / n;
  const x = onset.map((v) => v - mean);
  const minLag = Math.floor((60 * rate) / maxBpm);
  const maxLag = Math.ceil((60 * rate) / minBpm);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (n - lag);
  }
  if (ac[0] <= 0) return null;
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = Math.max(2, minLag); lag <= maxLag; lag++) {
    if (!(ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
    const bpm = (60 * rate) / lag;
    // Gentle preference for tempi around 120 BPM resolves octave ambiguity.
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (ac[lag] / ac[0]) * weight;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag < 0) return null;
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  const den = a - 2 * b + c;
  const refined = den !== 0 ? bestLag + (0.5 * (a - c)) / den : bestLag;
  return { bpm: (60 * rate) / refined, confidence: Math.max(0, Math.min(1, b / ac[0] * 2)) };
}

// ------------------------------------------------ pitch tracking

// Runs YIN across a whole signal. Returns times (s), frequencies (Hz, NaN
// where unvoiced) and frame levels.
export function pitchTrack(signal, sampleRate, opts = {}) {
  const { minFreq = 65, maxFreq = 1100, gateDb = -30 } = opts;
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const x = lowpassDecimate(signal, factor);
  const sr = sampleRate / factor;
  const win = nextPow2(Math.round(sr * 0.08));
  const hop = win >> 1;
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const levels = new Float32Array(frames);
  let maxLevel = 0;
  for (let f = 0; f < frames; f++) {
    levels[f] = rms(x, f * hop, f * hop + win);
    if (levels[f] > maxLevel) maxLevel = levels[f];
  }
  const gate = maxLevel * Math.pow(10, gateDb / 20);
  const times = new Float32Array(frames);
  const freqs = new Float32Array(frames).fill(NaN);
  const clarity = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    times[f] = (f * hop + win / 2) / sr;
    if (levels[f] < gate || levels[f] < 1e-4) continue;
    const r = yin(x.subarray(f * hop, f * hop + win), sr, { minFreq, maxFreq, threshold: 0.2 });
    if (r && r.clarity > 0.6) {
      freqs[f] = r.frequency;
      clarity[f] = r.clarity;
    }
  }
  // Remove isolated single-frame detections (usually octave errors / noise).
  for (let f = 1; f < frames - 1; f++) {
    if (!isNaN(freqs[f]) && isNaN(freqs[f - 1]) && isNaN(freqs[f + 1])) freqs[f] = NaN;
  }
  return { times, freqs, clarity, levels, hopSeconds: hop / sr };
}

// --------------------------------------------------- spectrograms

// Log-frequency row layout shared by every spectrogram in the app.
export function logBands(rows, fMin, fMax) {
  const edges = new Float32Array(rows + 1);
  for (let r = 0; r <= rows; r++) edges[r] = fMin * Math.pow(fMax / fMin, r / rows);
  return edges;
}

export class SpectrogramBuilder {
  constructor({ frames, cols, rows = 160, fMin = 40, fMax, sampleRate, fftSize }) {
    this.cols = Math.max(1, Math.min(cols, frames));
    this.rows = rows;
    this.fMin = fMin;
    this.fMax = fMax;
    this.frames = frames;
    this.data = new Float32Array(this.cols * rows);
    const edges = logBands(rows, fMin, fMax);
    const binHz = sampleRate / fftSize;
    this.rowLo = new Int32Array(rows);
    this.rowHi = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      const lo = Math.max(1, Math.floor(edges[r] / binHz));
      const hi = Math.max(lo, Math.min(fftSize / 2, Math.floor(edges[r + 1] / binHz)));
      this.rowLo[r] = lo;
      this.rowHi[r] = hi;
    }
  }

  // `power` is a per-bin power spectrum of frame `index`.
  add(index, power) {
    const col = Math.min(this.cols - 1, Math.floor((index * this.cols) / this.frames));
    const base = col * this.rows;
    for (let r = 0; r < this.rows; r++) {
      let m = 0;
      for (let b = this.rowLo[r]; b <= this.rowHi[r]; b++) if (power[b] > m) m = power[b];
      if (m > this.data[base + r]) this.data[base + r] = m;
    }
  }

  finish() {
    let max = 1e-20;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] > max) max = this.data[i];
    for (let i = 0; i < this.data.length; i++) this.data[i] = Math.max(-90, 10 * Math.log10(this.data[i] / max + 1e-12));
    return { data: this.data, cols: this.cols, rows: this.rows, fMin: this.fMin, fMax: this.fMax, dbMin: -90, dbMax: 0 };
  }
}

// ------------------------------------------------ source separation

export const BANDS = [
  { name: 'Sub-bass', lo: 20, hi: 60 },
  { name: 'Bass', lo: 60, hi: 250 },
  { name: 'Low-mid', lo: 250, hi: 500 },
  { name: 'Mid', lo: 500, hi: 2000 },
  { name: 'Upper-mid', lo: 2000, hi: 4000 },
  { name: 'Presence', lo: 4000, hi: 6000 },
  { name: 'Brilliance', lo: 6000, hi: 20000 },
];

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Splits a mix into an estimated vocal stem (mono) and an instrumental stem
 * (stereo) using three cues per STFT bin:
 *   1. centre-panning: vocals are almost always mixed to the centre, so bins
 *      where left and right agree in level and phase are vocal candidates;
 *   2. harmonicity: median-filter HPSS keeps sustained, pitched energy and
 *      rejects drum transients;
 *   3. vocal band: energy outside roughly 90 Hz – 11 kHz is left to the band.
 * Alongside the stems it gathers the per-frame statistics used by the
 * report (spectrograms, average spectra, onset envelope, chroma, H/P ratio).
 */
export function separateAndAnalyse(left, right, sampleRate, onProgress = () => {}) {
  const stereo = right && right !== left;
  const len = left.length;
  const N = sampleRate > 32000 ? 2048 : 1024;
  const hop = N / 2;
  const bins = N / 2 + 1;
  const binHz = sampleRate / N;
  const win = hann(N);
  const frames = Math.ceil((len + N) / hop);
  const frameStart = (f) => f * hop - N + hop;

  // Pass 1: mid-channel magnitudes, needed for median filtering in time.
  // Two real frames share one complex FFT (frame f in re, f + 1 in im).
  const mag = new Float32Array(frames * bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const midAt = (idx) => (idx >= 0 && idx < len ? (stereo ? 0.5 * (left[idx] + right[idx]) : left[idx]) : 0);
  for (let f = 0; f < frames; f += 2) {
    const s0 = frameStart(f);
    for (let i = 0; i < N; i++) {
      re[i] = midAt(s0 + i) * win[i];
      im[i] = f + 1 < frames ? midAt(s0 + hop + i) * win[i] : 0;
    }
    fft(re, im);
    const a = f * bins;
    const b = a + bins;
    for (let k = 0; k < bins; k++) {
      const j = (N - k) & (N - 1);
      mag[a + k] = 0.5 * Math.hypot(re[k] + re[j], im[k] - im[j]);
      if (f + 1 < frames) mag[b + k] = 0.5 * Math.hypot(im[k] + im[j], re[k] - re[j]);
    }
    if ((f & 63) === 0) onProgress(0.4 * (f / frames));
  }
  let sideEnergy = 0;
  let midEnergy = 0;
  if (stereo) {
    for (let i = 0; i < len; i += 4) {
      sideEnergy += (left[i] - right[i]) ** 2;
      midEnergy += (left[i] + right[i]) ** 2;
    }
  }
  // Treat near-identical channels (e.g. a mono file saved as stereo) as mono.
  const effectiveStereo = stereo && sideEnergy > midEnergy * 1e-3;

  const vocal = new Float32Array(len);
  const instL = new Float32Array(len);
  const instR = new Float32Array(len);
  const norm = new Float32Array(len);

  const T = 9; // time-median length (frames, ~0.2 s at 44.1 kHz)
  const F = 17; // frequency-median length (bins)
  const scratch = new Float32Array(F);
  const magAt = (t, k) => (t >= 0 && t < frames && k >= 0 && k < bins ? mag[t * bins + k] : 0);
  // One sorted window of T frames per bin, slid forward a frame at a time.
  const timeWin = new Float32Array(bins * T);
  for (let k = 0; k < bins; k++) {
    for (let t = 0; t < T; t++) timeWin[k * T + t] = magAt(t - (T >> 1), k);
    timeWin.subarray(k * T, (k + 1) * T).sort();
  }
  const bandW = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = k * binHz;
    bandW[k] = smoothstep(90, 180, f) * (1 - smoothstep(7000, 11000, f));
  }

  const fMax = Math.min(16000, sampleRate / 2);
  const cols = Math.min(900, frames);
  const specMix = new SpectrogramBuilder({ frames, cols, fMax, sampleRate, fftSize: N });
  const specVoc = new SpectrogramBuilder({ frames, cols, fMax, sampleRate, fftSize: N });
  const specInst = new SpectrogramBuilder({ frames, cols, fMax, sampleRate, fftSize: N });

  const avgMix = new Float64Array(bins);
  const avgVoc = new Float64Array(bins);
  const avgInst = new Float64Array(bins);
  const chroma = new Float64Array(12);
  const onset = new Float32Array(frames);
  const vocalFrameEnergy = new Float32Array(frames);
  const mixFrameEnergy = new Float32Array(frames);
  let harmEnergy = 0;
  let percEnergy = 0;
  const pMix = new Float32Array(bins);
  const pVoc = new Float32Array(bins);
  const pInst = new Float32Array(bins);
  const prevInstLog = new Float32Array(bins);
  const chromaBin = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f >= 55 && f <= 2000) chromaBin[k] = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12;
  }

  const lRe = new Float64Array(bins); const lIm = new Float64Array(bins);
  const rRe = new Float64Array(bins); const rIm = new Float64Array(bins);
  const hpH = new Float32Array(bins);
  const hpP = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const s0 = frameStart(f);
    // Left in the real part, right in the imaginary part, then unpack.
    for (let i = 0; i < N; i++) {
      const idx = s0 + i;
      const inRange = idx >= 0 && idx < len;
      re[i] = inRange ? left[idx] * win[i] : 0;
      im[i] = inRange && stereo ? right[idx] * win[i] : re[i];
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const j = (N - k) & (N - 1);
      lRe[k] = 0.5 * (re[k] + re[j]); lIm[k] = 0.5 * (im[k] - im[j]);
      rRe[k] = 0.5 * (im[k] + im[j]); rIm[k] = -0.5 * (re[k] - re[j]);
    }

    // HPSS medians for this frame.
    for (let k = 0; k < bins; k++) {
      if (f > 0) sortedReplace(timeWin, k * T, T, magAt(f - (T >> 1) - 1, k), magAt(f + (T >> 1), k));
      hpH[k] = timeWin[k * T + (T >> 1)];
    }
    for (let j = 0; j < F; j++) scratch[j] = magAt(f, j - (F >> 1));
    smallMedian(scratch, F);
    for (let k = 0; k < bins; k++) {
      if (k > 0) sortedReplace(scratch, 0, F, magAt(f, k - (F >> 1) - 1), magAt(f, k + (F >> 1)));
      hpP[k] = scratch[F >> 1];
    }

    let flux = 0;
    for (let k = 0; k < bins; k++) {
      const lr = lRe[k], li = lIm[k], rr = rRe[k], ri = rIm[k];
      const mr = 0.5 * (lr + rr);
      const mi = 0.5 * (li + ri);
      const pl = lr * lr + li * li;
      const pr = rr * rr + ri * ri;
      let centre = 1;
      if (effectiveStereo) {
        const cross = (lr * rr + li * ri) * 2 / (pl + pr + 1e-20);
        centre = cross > 0 ? cross * cross * cross * cross : 0;
      }
      const h2 = hpH[k] * hpH[k];
      const p2 = hpP[k] * hpP[k];
      const harm = h2 / (h2 + p2 + 1e-20);
      const m = bandW[k] * centre * harm;
      const vr = m * mr;
      const vi = m * mi;

      const mixP = mr * mr + mi * mi;
      const vocP = m * m * mixP;
      const ilr = lr - vr, ili = li - vi;
      const irr = rr - vr, iri = ri - vi;
      // Pack instrumental L + i·R so a single inverse FFT yields both.
      re[k] = ilr - iri; im[k] = ili + irr;
      if (k > 0 && k < N / 2) { re[N - k] = ilr + iri; im[N - k] = irr - ili; }
      const instP = 0.25 * ((ilr + irr) ** 2 + (ili + iri) ** 2);
      pMix[k] = mixP; pVoc[k] = vocP; pInst[k] = instP;
      avgMix[k] += mixP; avgVoc[k] += vocP; avgInst[k] += instP;
      vocalFrameEnergy[f] += vocP;
      mixFrameEnergy[f] += mixP;
      harmEnergy += instP * harm;
      percEnergy += instP * (1 - harm);
      if (chromaBin[k] >= 0) chroma[chromaBin[k]] += mixP * harm;
      const lg = Math.log1p(1000 * Math.sqrt(instP));
      if (lg > prevInstLog[k]) flux += lg - prevInstLog[k];
      prevInstLog[k] = lg;
    }
    onset[f] = flux;
    specMix.add(f, pMix);
    specVoc.add(f, pVoc);
    specInst.add(f, pInst);

    fft(re, im, true);
    // vocal = mid − mid(instrumental), since the vocal was removed from both sides.
    for (let i = 0; i < N; i++) {
      const idx = s0 + i;
      if (idx < 0 || idx >= len) continue;
      const w = win[i];
      const mid = (stereo ? 0.5 * (left[idx] + right[idx]) : left[idx]) * w;
      vocal[idx] += (mid - 0.5 * (re[i] + im[i])) * w;
      instL[idx] += re[i] * w;
      instR[idx] += im[i] * w;
      norm[idx] += w * w;
    }
    if ((f & 31) === 0) onProgress(0.4 + 0.5 * (f / frames));
  }
  for (let i = 0; i < len; i++) {
    const n = norm[i] > 1e-6 ? norm[i] : 1;
    vocal[i] /= n; instL[i] /= n; instR[i] /= n;
  }

  // Average spectra on a log-frequency grid, in dB.
  const points = 200;
  const freqs = new Float32Array(points);
  const toCurve = (acc) => {
    const out = new Float32Array(points);
    const edges = logBands(points, 30, fMax);
    for (let p = 0; p < points; p++) {
      freqs[p] = Math.sqrt(edges[p] * edges[p + 1]);
      const lo = Math.max(1, Math.floor(edges[p] / binHz));
      const hi = Math.max(lo, Math.min(bins - 1, Math.floor(edges[p + 1] / binHz)));
      let s = 0;
      for (let k = lo; k <= hi; k++) s += acc[k];
      out[p] = s / (hi - lo + 1) / frames;
    }
    return out;
  };
  const curves = { mix: toCurve(avgMix), vocal: toCurve(avgVoc), inst: toCurve(avgInst) };
  let peak = 1e-20;
  for (const c of Object.values(curves)) for (const v of c) if (v > peak) peak = v;
  for (const c of Object.values(curves)) for (let i = 0; i < c.length; i++) c[i] = Math.max(-90, 10 * Math.log10(c[i] / peak + 1e-12));

  const bandShare = (acc) => {
    const e = BANDS.map((b) => {
      let s = 0;
      for (let k = Math.ceil(b.lo / binHz); k <= Math.min(bins - 1, Math.floor(b.hi / binHz)); k++) s += acc[k];
      return s;
    });
    const total = e.reduce((s, v) => s + v, 0) || 1;
    return e.map((v) => v / total);
  };

  const totalVoc = avgVoc.reduce((s, v) => s + v, 0);
  const totalMix = avgMix.reduce((s, v) => s + v, 0) || 1;
  let activeFrames = 0;
  let loudFrames = 0;
  const maxMixFrame = Math.max(...mixFrameEnergy);
  for (let f = 0; f < frames; f++) {
    if (mixFrameEnergy[f] < maxMixFrame * 1e-4) continue;
    loudFrames++;
    if (vocalFrameEnergy[f] > 0.15 * mixFrameEnergy[f]) activeFrames++;
  }

  onProgress(0.9);
  return {
    vocal,
    instL,
    instR: effectiveStereo ? instR : instL,
    mode: effectiveStereo ? 'stereo' : 'mono',
    spectrograms: { mix: specMix.finish(), vocal: specVoc.finish(), inst: specInst.finish() },
    avgSpectrum: { freqs, ...curves },
    bands: { names: BANDS.map((b) => b.name), mix: bandShare(avgMix), vocal: bandShare(avgVoc), inst: bandShare(avgInst) },
    vocalShare: totalVoc / totalMix,
    vocalPresence: loudFrames ? activeFrames / loudFrames : 0,
    harmonicRatio: harmEnergy / (harmEnergy + percEnergy + 1e-20),
    chroma: Array.from(chroma),
    onset,
    frameRate: sampleRate / hop,
  };
}
