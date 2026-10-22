// Full-recording analysis: separation, pitch statistics, sound summary,
// key and tempo. Runs inside the worker (and directly in the unit tests).

import {
  separateAndAnalyse, pitchTrack, median, percentile, frequencyToNote, wavelength,
  voiceType, estimateKey, estimateTempo, magnitudeSpectrum, harmonics, formants,
  classifyVowel, yin, rms, toDb, lowpassDecimate,
} from './dsp.js';

export const MAX_SECONDS = 8 * 60;

function pitchStats(track) {
  const voiced = [];
  for (const f of track.freqs) if (!isNaN(f)) voiced.push(f);
  if (voiced.length < 3) return null;
  const med = median(voiced);
  const low = percentile(voiced, 5);
  const high = percentile(voiced, 95);
  return {
    median: med,
    low,
    high,
    note: frequencyToNote(med),
    lowNote: frequencyToNote(low),
    highNote: frequencyToNote(high),
    rangeSemitones: 12 * Math.log2(high / low),
    voicedFraction: voiced.length / track.freqs.length,
  };
}

// Index of the loudest frame whose pitch is held steady for ~0.3 s, so a
// drum hit or a consonant is never mistaken for "the" note of a sound.
function steadiestFrame(track) {
  const reach = Math.max(1, Math.round(0.15 / track.hopSeconds));
  let best = -1;
  let bestScore = 0;
  for (let i = reach; i < track.freqs.length - reach; i++) {
    const f = track.freqs[i];
    if (isNaN(f)) continue;
    let steady = true;
    for (let j = i - reach; j <= i + reach && steady; j++) {
      steady = !isNaN(track.freqs[j]) && Math.abs(Math.log(track.freqs[j] / f)) < 0.03;
    }
    const score = steady ? track.levels[i] * track.clarity[i] : 0;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function frameAt(signal, sampleRate, time, size) {
  const start = Math.max(0, Math.min(signal.length - size, Math.round(time * sampleRate - size / 2)));
  return signal.subarray(start, start + size);
}

// Describes the steadiest, loudest pitched moment of the recording: the
// fundamental, harmonics and wavelength, plus the closest vowel. Formants are
// read from `voice` (the vocal stem) when one was found, since instruments
// would otherwise masquerade as vowel resonances.
function soundSummary(signal, sampleRate, track, voice) {
  const hopSamples = Math.round(track.hopSeconds * sampleRate);
  const best = steadiestFrame(track);
  const size = sampleRate > 32000 ? 4096 : 2048;
  if (signal.length < size) return null;
  let start;
  if (best >= 0) {
    start = Math.round(track.times[best] * sampleRate - size / 2);
  } else {
    // Unpitched sound: use the loudest window instead.
    let loud = 0;
    start = 0;
    for (let s = 0; s + size <= signal.length; s += hopSamples || size) {
      const r = rms(signal, s, s + size);
      if (r > loud) { loud = r; start = s; }
    }
  }
  start = Math.max(0, Math.min(signal.length - size, start));
  const frame = signal.subarray(start, start + size);
  const mag = magnitudeSpectrum(frame, size);

  let peakBin = 1;
  for (let k = 2; k < mag.length; k++) if (mag[k] > mag[peakBin]) peakBin = k;
  const dominant = (peakBin * sampleRate) / size;

  const factor = Math.max(1, Math.floor(sampleRate / 22050));
  const pitch = yin(lowpassDecimate(frame, factor), sampleRate / factor, { minFreq: 50, maxFreq: 2000 });
  const f0 = pitch ? pitch.frequency : NaN;
  let fm = null;
  if (voice) {
    const vf = steadiestFrame(voice.track);
    if (vf >= 0) fm = formants(frameAt(voice.signal, sampleRate, voice.track.times[vf], size), sampleRate);
  } else if (f0 > 0) {
    fm = formants(frame, sampleRate);
  }
  return {
    time: start / sampleRate,
    f0,
    clarity: pitch ? pitch.clarity : 0,
    note: frequencyToNote(f0),
    wavelength: wavelength(f0),
    periodMs: f0 > 0 ? 1000 / f0 : NaN,
    dominant,
    dominantWavelength: wavelength(dominant),
    harmonics: f0 > 0 ? harmonics(mag, sampleRate, size, f0, 10) : [],
    formants: fm,
    vowel: fm ? classifyVowel(fm.f1, fm.f2) : null,
  };
}

function loudness(channels) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      sum += ch[i] * ch[i];
    }
    n += ch.length;
  }
  return { peakDb: toDb(peak), rmsDb: toDb(Math.sqrt(sum / Math.max(1, n))) };
}

function describeInstruments(res, tempo) {
  const [sub, bass, lowMid, mid, upperMid, presence, brilliance] = res.bands.inst;
  const notes = [];
  const perc = 1 - res.harmonicRatio;
  if (perc > 0.45) notes.push('Strong drums / percussion — the instrumental is rhythm-driven.');
  else if (perc > 0.25) notes.push('Noticeable drums or percussive attacks.');
  else notes.push('Mostly sustained, pitched instruments with little percussion.');
  if (sub + bass > 0.45) notes.push('Heavy low end: bass guitar, synth bass or kick drum dominate.');
  else if (sub + bass > 0.25) notes.push('Solid bass line present.');
  if (lowMid + mid > 0.4) notes.push('Rich mid-range: guitars, piano/keys or pads carry the harmony.');
  if (upperMid + presence > 0.15) notes.push('Bright upper-mids: lead instruments, strings or guitar bite.');
  if (brilliance > 0.08) notes.push('Airy highs: cymbals, hi-hats or shimmer.');
  if (tempo && tempo.confidence > 0.3) notes.push(`Steady pulse around ${Math.round(tempo.bpm)} BPM.`);
  return notes;
}

export function analyse({ channels, sampleRate }, onProgress = () => {}) {
  let left = channels[0];
  let right = channels[1] || null;
  let truncated = false;
  const maxLen = Math.floor(MAX_SECONDS * sampleRate);
  if (left.length > maxLen) {
    truncated = true;
    left = left.subarray(0, maxLen);
    if (right) right = right.subarray(0, maxLen);
  }
  const duration = left.length / sampleRate;

  const sep = separateAndAnalyse(left, right, sampleRate, (p) => onProgress(p * 0.85, 'Separating vocals and instruments'));

  onProgress(0.86, 'Tracking vocal pitch');
  const vocalTrack = pitchTrack(sep.vocal, sampleRate);
  const vocalStats = pitchStats(vocalTrack);

  onProgress(0.93, 'Measuring the overall sound');
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = right ? 0.5 * (left[i] + right[i]) : left[i];
  const mixTrack = pitchTrack(mono, sampleRate, { minFreq: 50, maxFreq: 1500, gateDb: -25 });
  const mixStats = pitchStats(mixTrack);
  // Report vocals only when there is meaningful pitched centre content.
  const hasVocals = sep.vocalShare > 0.02 && sep.vocalPresence > 0.05 && !!vocalStats;
  const sound = soundSummary(mono, sampleRate, mixTrack, hasVocals ? { signal: sep.vocal, track: vocalTrack } : null);

  onProgress(0.97, 'Estimating key and tempo');
  const key = estimateKey(sep.chroma);
  const tempo = duration >= 6 ? estimateTempo(Array.from(sep.onset), sep.frameRate) : null;

  const result = {
    meta: { duration, sampleRate, channels: channels.length, truncated, separationMode: sep.mode },
    loudness: loudness(right ? [left, right] : [left]),
    sound,
    mixPitch: mixStats,
    vocal: {
      detected: hasVocals,
      share: sep.vocalShare,
      presence: sep.vocalPresence,
      pitch: vocalStats,
      voiceType: vocalStats ? voiceType(vocalStats.median) : null,
      wavelength: vocalStats ? wavelength(vocalStats.median) : NaN,
      track: { times: vocalTrack.times, freqs: vocalTrack.freqs },
    },
    instrumental: {
      harmonicRatio: sep.harmonicRatio,
      percussiveRatio: 1 - sep.harmonicRatio,
      key: duration >= 4 ? key : null,
      tempo,
      profile: null,
    },
    bands: sep.bands,
    avgSpectrum: sep.avgSpectrum,
    spectrograms: sep.spectrograms,
    stems: { vocal: sep.vocal, instL: sep.instL, instR: sep.instR },
  };
  result.instrumental.profile = describeInstruments(sep, tempo);
  onProgress(1, 'Done');
  return result;
}
