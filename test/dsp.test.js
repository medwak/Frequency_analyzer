import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yin, frequencyToNote, wavelength, formants, classifyVowel, estimateKey, estimateTempo,
  fft, pitchTrack,
} from '../www/js/dsp.js';
import { analyse } from '../www/js/analysis.js';
import { synthVowel, synthSong, harmonicTone } from './synth.js';

const SR = 44100;

function close(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function corr(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}

test('fft round-trips a signal', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.3) + 0.1 * i);
  const orig = Float64Array.from(re);
  const im = new Float64Array(64);
  fft(re, im);
  fft(re, im, true);
  for (let i = 0; i < 64; i++) close(re[i], orig[i], 1e-9, `sample ${i}`);
});

test('note naming and wavelength', () => {
  assert.equal(frequencyToNote(440).label, 'A4');
  assert.equal(frequencyToNote(261.63).label, 'C4');
  assert.equal(frequencyToNote(445).cents, 20);
  close(wavelength(343, 20), 1.0, 0.01, 'wavelength of 343 Hz');
  close(wavelength(100, 0), 3.313, 0.001, 'wavelength at 0°C');
});

test('yin finds the fundamental of pure and harmonic tones', () => {
  for (const f of [82.4, 110, 220, 440, 880]) {
    const sine = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
    close(yin(sine, SR, { minFreq: 60 }).frequency, f, f * 0.005, `sine ${f}`);
    const rich = harmonicTone(f, 4096, SR, 12);
    close(yin(rich, SR, { minFreq: 60 }).frequency, f, f * 0.005, `harmonic ${f}`);
  }
  const noise = Float32Array.from({ length: 4096 }, () => Math.random() * 2 - 1);
  const r = yin(noise, SR);
  assert.ok(!r || r.clarity < 0.75, 'white noise should not be confidently pitched');
});

test('formants and vowel classification on synthetic vowels', () => {
  const cases = [
    { f1: 300, f2: 2400, ipa: 'i' },
    { f1: 780, f2: 1300, ipa: 'a' },
    { f1: 320, f2: 850, ipa: 'u' },
  ];
  for (const c of cases) {
    const x = synthVowel(130, [c.f1, c.f2, 2900], 4096, SR);
    const fm = formants(x, SR);
    assert.ok(fm, `formants for ${c.ipa}`);
    close(fm.f1, c.f1, c.f1 * 0.15, `F1 of ${c.ipa}`);
    close(fm.f2, c.f2, c.f2 * 0.15, `F2 of ${c.ipa}`);
    assert.equal(classifyVowel(fm.f1, fm.f2).ipa, c.ipa);
  }
});

test('key estimation from a C-major / A-minor chroma', () => {
  const cMajor = [5, 0, 3, 0, 4, 3, 0, 5, 0, 3, 0, 2];
  assert.equal(estimateKey(cMajor).name, 'C major');
  const aMinor = [3, 0, 2, 3, 4, 2, 0, 2, 1, 6, 0, 2];
  assert.equal(estimateKey(aMinor).name, 'A minor');
});

test('tempo from a periodic onset envelope', () => {
  const rate = 43;
  const onset = Array.from({ length: rate * 20 }, (_, i) => (i % Math.round((rate * 60) / 100) === 0 ? 1 : 0.05));
  close(estimateTempo(onset, rate).bpm, 100, 3, 'tempo');
});

test('pitch track follows a glide', () => {
  const n = SR * 2;
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = 200 + 200 * (i / n);
    phase += (2 * Math.PI * f) / SR;
    x[i] = 0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase);
  }
  const t = pitchTrack(x, SR);
  const mid = Math.floor(t.freqs.length / 2);
  close(t.freqs[mid], 200 + 200 * (t.times[mid] / 2), 6, 'mid-glide pitch');
});

test('full analysis separates a centre vocal from panned instruments and drums', () => {
  const song = synthSong(SR, 12);
  const res = analyse({ channels: [song.left, song.right], sampleRate: SR });
  assert.equal(res.meta.separationMode, 'stereo');
  assert.ok(res.vocal.detected, 'vocal should be detected');
  close(res.vocal.pitch.median, 220, 8, 'vocal median pitch');
  // The vocal stem should resemble the vocal source far more than the instruments.
  const cv = corr(res.stems.vocal, song.vocal);
  const ci = corr(res.stems.vocal, song.instruments);
  assert.ok(cv > 0.8, `vocal stem vs vocal source correlation ${cv}`);
  assert.ok(Math.abs(ci) < 0.3, `vocal stem vs instruments correlation ${ci}`);
  close(res.instrumental.tempo.bpm, 120, 4, 'tempo');
  assert.ok(res.instrumental.percussiveRatio > 0.05, 'drums should register as percussive energy');
  // The sound summary must describe a sustained note, never a 70 Hz kick drum.
  assert.ok(res.sound.f0 > 100, `sound summary f0 ${res.sound.f0}`);
});

test('a sustained vowel recording is summarised', () => {
  const x = synthVowel(196, [780, 1300, 2600], SR * 2, SR);
  const res = analyse({ channels: [x], sampleRate: SR });
  close(res.sound.f0, 196, 2, 'f0');
  assert.equal(res.sound.note.label, 'G3');
  close(res.sound.wavelength, 343.42 / 196, 0.02, 'wavelength');
  assert.equal(res.sound.vowel.ipa, 'a');
  assert.ok(res.sound.harmonics.length >= 5);
});
