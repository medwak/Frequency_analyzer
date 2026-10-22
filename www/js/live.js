// Live microphone analysis: pitch, wavelength, spectrum, formants.

import {
  yin, formants, classifyVowel, harmonics, frequencyToNote, wavelength,
  formatFrequency, formatLength, lowpassDecimate, rms, toDb, median,
} from './dsp.js';
import { drawSpectrum, drawPitchHistory, drawVowelChart, renderHarmonics } from './charts.js';

const HISTORY_MS = 10000;
const $ = (id) => document.getElementById(id);

export class LiveAnalyser {
  constructor(settings, { onRecording, onError }) {
    this.settings = settings;
    this.onRecording = onRecording;
    this.onError = onError;
    this.running = false;
    this.held = false;
    this.history = [];
    this.recent = [];
    this.formantTrail = [];
    this.formantState = null;
    this.stats = { min: Infinity, max: 0, sum: 0, n: 0 };
    this.visible = true;
    this.els = {
      toggle: $('live-toggle'), hold: $('live-hold'), record: $('live-record'),
      status: $('live-status'), freq: $('live-freq'), note: $('live-note'), cents: $('live-cents'),
      needle: $('live-needle'), wavelength: $('live-wavelength'), period: $('live-period'),
      clarity: $('live-clarity'), level: $('live-level'), peak: $('live-peak'),
      spectrum: $('live-spectrum'), historyCanvas: $('live-history'),
      min: $('live-min'), max: $('live-max'), avg: $('live-avg'),
      vowelIpa: $('live-vowel-ipa'), vowelLabel: $('live-vowel-label'),
      f1: $('live-f1'), f2: $('live-f2'), f3: $('live-f3'), vowelChart: $('live-vowel-chart'),
      harmonics: $('live-harmonics'),
    };
    this.els.toggle.addEventListener('click', () => (this.running ? this.stop() : this.start()));
    this.els.hold.addEventListener('click', () => this.toggleHold());
    this.els.record.addEventListener('click', () => this.toggleRecording());
    $('live-reset').addEventListener('click', () => this.resetStats());
    if (typeof MediaRecorder === 'undefined') this.els.record.hidden = true;
    this.drawIdle();
  }

  drawIdle() {
    drawSpectrum(this.els.spectrum, null, 48000, 0);
    drawPitchHistory(this.els.historyCanvas, [], performance.now(), HISTORY_MS, this.settings.a4);
    drawVowelChart(this.els.vowelChart, 0, 0);
    renderHarmonics(this.els.harmonics, []);
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.onError('Microphone access needs a secure (https) connection and a modern browser.');
      return;
    }
    try {
      // Turn off voice processing: echo cancellation and noise suppression
      // distort the very frequencies we want to measure.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      this.onError(err && err.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow it in your browser or app settings and try again.'
        : `Could not open the microphone: ${err && err.message ? err.message : err}`);
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.5;
    this.source.connect(this.analyser);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.running = true;
    this.els.toggle.classList.add('stop');
    this.els.toggle.querySelector('span').textContent = 'Stop';
    this.els.hold.disabled = false;
    this.els.record.disabled = false;
    this.els.status.textContent = `Listening · ${(this.ctx.sampleRate / 1000).toFixed(1)} kHz`;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.els.toggle.classList.remove('stop');
    this.els.toggle.querySelector('span').textContent = 'Start listening';
    this.els.hold.disabled = true;
    this.els.record.disabled = true;
    this.held = false;
    this.els.hold.classList.remove('active');
    this.els.status.textContent = 'Stopped. Tap Start listening to continue.';
    this.els.needle.classList.remove('on');
  }

  toggleHold() {
    this.held = !this.held;
    this.els.hold.classList.toggle('active', this.held);
    this.els.hold.textContent = this.held ? 'Held' : 'Hold';
  }

  toggleRecording() {
    if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.stop();
      return;
    }
    const chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this.recorder.onstop = () => {
      clearTimeout(this.recTimer);
      clearInterval(this.recClock);
      this.els.record.classList.remove('recording');
      this.els.record.textContent = '● Rec';
      if (chunks.length) this.onRecording(new Blob(chunks, { type: this.recorder.mimeType }));
    };
    this.recorder.start();
    const started = Date.now();
    this.els.record.classList.add('recording');
    this.els.record.textContent = '■ 0s';
    this.recClock = setInterval(() => {
      this.els.record.textContent = `■ ${Math.floor((Date.now() - started) / 1000)}s`;
    }, 250);
    this.recTimer = setTimeout(() => this.recorder.state === 'recording' && this.recorder.stop(), 30000);
  }

  resetStats() {
    this.stats = { min: Infinity, max: 0, sum: 0, n: 0 };
    this.history = [];
    this.formantTrail = [];
    this.els.min.textContent = this.els.max.textContent = this.els.avg.textContent = '—';
  }

  tick() {
    if (this.held) return;
    const sr = this.ctx.sampleRate;
    const now = performance.now();
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    this.analyser.getFloatFrequencyData(this.freqBuf);
    const levelDb = toDb(rms(this.timeBuf));
    let f0 = NaN;
    let clarity = 0;
    if (levelDb > -60) {
      const factor = sr >= 44100 ? 2 : 1;
      const x = factor > 1 ? lowpassDecimate(this.timeBuf, factor) : this.timeBuf;
      const r = yin(x, sr / factor, { minFreq: 50, maxFreq: 2000, threshold: 0.12 });
      if (r && r.clarity > 0.7) { f0 = r.frequency; clarity = r.clarity; }
    }
    // Median of the last few estimates steadies the display.
    this.recent.push(f0);
    if (this.recent.length > 5) this.recent.shift();
    const valid = this.recent.filter((v) => v > 0);
    const shown = f0 > 0 && valid.length >= 3 ? median(valid) : NaN;

    this.history.push({ t: now, f: shown });
    while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift();
    if (shown > 0) {
      this.stats.min = Math.min(this.stats.min, shown);
      this.stats.max = Math.max(this.stats.max, shown);
      this.stats.sum += shown;
      this.stats.n++;
    }

    let fm = null;
    if (shown > 0 && clarity > 0.8 && levelDb > -50) fm = formants(this.timeBuf, sr);
    if (fm && fm.f2 > 0) {
      const s = this.formantState;
      const a = 0.35;
      this.formantState = s
        ? { f1: s.f1 + a * (fm.f1 - s.f1), f2: s.f2 + a * (fm.f2 - s.f2), f3: fm.f3 > 0 ? (s.f3 > 0 ? s.f3 + a * (fm.f3 - s.f3) : fm.f3) : s.f3, t: now }
        : { ...fm, t: now };
      this.formantTrail.push({ f1: this.formantState.f1, f2: this.formantState.f2 });
      if (this.formantTrail.length > 40) this.formantTrail.shift();
    } else if (this.formantState && now - this.formantState.t > 600) {
      this.formantState = null;
    }

    if (!this.visible) return;
    this.render({ shown, clarity, levelDb, sr });
  }

  render({ shown, clarity, levelDb, sr }) {
    const { a4, tempC } = this.settings;
    const e = this.els;
    let peakBin = 1;
    for (let k = 2; k < this.freqBuf.length; k++) if (this.freqBuf[k] > this.freqBuf[peakBin]) peakBin = k;
    const peakHz = (peakBin * sr) / this.analyser.fftSize;
    e.peak.textContent = levelDb > -70 ? `Peak ${formatFrequency(peakHz)}` : 'Peak —';
    e.level.innerHTML = `${levelDb.toFixed(0)} <small>dBFS</small>`;

    if (shown > 0) {
      const note = frequencyToNote(shown, a4);
      e.freq.textContent = shown >= 1000 ? shown.toFixed(0) : shown.toFixed(1);
      e.note.textContent = note.label;
      e.cents.textContent = `${note.cents > 0 ? '+' : ''}${note.cents}¢`;
      e.needle.style.left = `${50 + note.cents}%`;
      e.needle.classList.add('on');
      e.needle.classList.toggle('in-tune', Math.abs(note.cents) <= 5);
      e.wavelength.textContent = formatLength(wavelength(shown, tempC));
      e.period.innerHTML = `${(1000 / shown).toFixed(2)} <small>ms</small>`;
      e.clarity.textContent = `${Math.round(clarity * 100)}%`;
      const mag = Float32Array.from(this.freqBuf, (db) => Math.pow(10, db / 20));
      renderHarmonics(e.harmonics, harmonics(mag, sr, this.analyser.fftSize, shown, 8));
    } else {
      e.needle.classList.remove('on');
      e.clarity.textContent = levelDb > -60 ? 'no pitch' : 'quiet';
    }
    if (this.stats.n) {
      e.min.textContent = `${formatFrequency(this.stats.min)} (${frequencyToNote(this.stats.min, a4).label})`;
      e.max.textContent = `${formatFrequency(this.stats.max)} (${frequencyToNote(this.stats.max, a4).label})`;
      const avg = this.stats.sum / this.stats.n;
      e.avg.textContent = `${formatFrequency(avg)} (${frequencyToNote(avg, a4).label})`;
    }

    const fs = this.formantState;
    if (fs) {
      e.f1.textContent = `${Math.round(fs.f1)} Hz`;
      e.f2.textContent = `${Math.round(fs.f2)} Hz`;
      e.f3.textContent = fs.f3 > 0 ? `${Math.round(fs.f3)} Hz` : '—';
      const v = classifyVowel(fs.f1, fs.f2);
      if (v) {
        e.vowelIpa.textContent = `/${v.ipa}/`;
        e.vowelLabel.textContent = `${v.label}${v.confidence < 0.3 ? ' · unsure' : ''}`;
      }
    }

    drawSpectrum(e.spectrum, this.freqBuf, sr, shown);
    drawPitchHistory(e.historyCanvas, this.history, performance.now(), HISTORY_MS, a4);
    drawVowelChart(e.vowelChart, fs ? fs.f1 : 0, fs ? fs.f2 : 0, this.formantTrail);
  }

  setVisible(v) {
    this.visible = v;
    if (v && !this.running) this.drawIdle();
  }
}
