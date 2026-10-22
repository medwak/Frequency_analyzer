// Synthetic test signals.

export function harmonicTone(f0, n, sr, count = 10) {
  const x = new Float32Array(n);
  for (let k = 1; k <= count && f0 * k < sr / 2; k++) {
    for (let i = 0; i < n; i++) x[i] += Math.sin((2 * Math.PI * f0 * k * i) / sr) / k;
  }
  return x;
}

// Glottal pulse train shaped by second-order resonators at the formants.
export function synthVowel(f0, formantFreqs, n, sr) {
  let x = new Float32Array(n);
  const period = sr / f0;
  for (let p = 0; p < n; p += period) {
    const i = Math.floor(p);
    if (i < n) x[i] = 1;
  }
  // Glottal source roll-off (-12 dB/oct) plus lip radiation (+6 dB/oct).
  for (let i = 1; i < n; i++) x[i] += 0.95 * x[i - 1];
  for (const f of formantFreqs) {
    const bw = 60 + f * 0.05;
    const r = Math.exp((-Math.PI * bw) / sr);
    const a1 = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    const a2 = -r * r;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] + a1 * (y[i - 1] || 0) + a2 * (y[i - 2] || 0);
    x = y;
  }
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] = (0.5 * x[i]) / max;
  return x;
}

// A small stereo "song": a centre-panned sung vowel with vibrato, two
// hard-panned harmonic instruments and centre drums at 120 BPM.
export function synthSong(sr, seconds) {
  const n = Math.floor(sr * seconds);
  const vocal = new Float32Array(n);
  const instL = new Float32Array(n);
  const instR = new Float32Array(n);
  const drums = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 220 * Math.pow(2, (0.3 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
    phase += (2 * Math.PI * f) / sr;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * phase) / (k * k * 0.5 + 0.5);
    vocal[i] = 0.25 * v;
    instL[i] = 0.12 * (Math.sin(2 * Math.PI * 330 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t));
    instR[i] = 0.12 * (Math.sin(2 * Math.PI * 523.25 * t) + 0.4 * Math.sin(2 * Math.PI * 1046.5 * t));
  }
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const beat = Math.round(sr * 0.5);
  for (let s = 0; s < n; s += beat) {
    for (let i = 0; i < sr * 0.08 && s + i < n; i++) {
      const env = Math.exp(-i / (sr * 0.015));
      drums[s + i] += 0.6 * env * (rand() * 0.6 + Math.sin((2 * Math.PI * 70 * i) / sr));
    }
  }
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const instruments = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = vocal[i] + instL[i] + drums[i];
    right[i] = vocal[i] + instR[i] + drums[i];
    instruments[i] = instL[i] + instR[i] + drums[i];
  }
  return { left, right, vocal, instruments };
}
