// Live microphone analysis: pitch, wavelength, spectrum, formants.

import {
  yin, formants, classifyVowel, harmonics, frequencyToNote, wavelength,
  formatFrequency, formatLength, lowpassDecimate, rms, toDb, median,
} from './dsp.js';
import { drawSpectrum, drawPitchHistory, drawVowelChart, renderHarmonics } from './charts.js';

const HISTORY_MS = 10000;
const SILENCE_DB = -75;
const $ = (id) => document.getElementById(id);

// Plain-language explanation and fix for each way opening the mic can fail.
function micProblem(err) {
  const name = err && err.name;
  const os = /Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'other';
  const osPrivacy = os === 'mac'
    ? 'On a Mac: System Settings → Privacy & Security → Microphone, and switch on your browser.'
    : os === 'win'
      ? 'On Windows: Settings → Privacy & security → Microphone, and turn on "Let desktop apps access your microphone".'
      : 'Check that your system allows the browser to use the microphone.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'NotSupportedError' || name === 'SecurityError') {
    return {
      title: 'Microphone access is blocked',
      steps: [
        'Click the icon at the left of the address bar (or the crossed-out camera/mic icon at the right) and set Microphone to Allow.',
        location.protocol === 'file:'
          ? 'For pages opened from your computer, Chrome may not remember the choice — allow it each time it asks.'
          : 'Or open chrome://settings/content/microphone and remove this site from "Not allowed".',
        osPrivacy,
        'Then press Start listening again.',
      ],
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No microphone was found',
      steps: [
        'Plug in a microphone or headset, or enable the built-in one.',
        'On a desktop PC without a microphone, a phone or a USB/headset mic is needed.',
        'Then press Start listening again.',
      ],
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'The microphone could not be started',
      steps: [
        'Another app may be using it — close Zoom, Teams, Discord, or other tabs that use the mic.',
        osPrivacy,
        'Unplug and reconnect a USB/Bluetooth microphone, then press Start listening again.',
      ],
    };
  }
  if (name === 'Unsupported') {
    return {
      title: 'This browser cannot use the microphone here',
      steps: [
        'Use an up-to-date Chrome, Edge, Firefox or Safari.',
        'If you opened the site through a network address like http://192.168…, use https:// or open it on this computer instead — browsers only allow the microphone on secure pages.',
      ],
    };
  }
  return {
    title: 'The microphone could not be opened',
    steps: [`The browser reported: ${(err && (err.message || err.name)) || err}.`, 'Reload the page and try again.'],
  };
}

export class LiveAnalyser {
  constructor(settings, { onRecording, onSettingsChange }) {
    this.settings = settings;
    this.onRecording = onRecording;
    this.onSettingsChange = onSettingsChange;
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
      harmonics: $('live-harmonics'), alert: $('live-alert'), device: $('live-device'),
    };
    this.els.device.addEventListener('change', () => {
      this.settings.micId = this.els.device.value;
      if (this.onSettingsChange) this.onSettingsChange();
      if (this.running) { this.stop(); this.start(); }
    });
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

  showAlert(problem, tone = 'error') {
    const a = this.els.alert;
    if (!problem) { a.hidden = true; return; }
    a.className = `live-alert ${tone}`;
    a.innerHTML = '';
    const h = document.createElement('strong');
    h.textContent = problem.title;
    const ol = document.createElement('ol');
    for (const step of problem.steps) {
      const li = document.createElement('li');
      li.textContent = step;
      ol.appendChild(li);
    }
    a.append(h, ol);
    a.hidden = false;
  }

  async openStream() {
    const tuning = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const id = this.settings.micId;
    const attempts = [
      // Voice processing (echo cancellation, noise suppression) distorts the
      // very frequencies we measure, so ask for the raw signal first...
      { ...tuning, ...(id ? { deviceId: { exact: id } } : {}) },
      // ...then fall back to whatever the device supports.
      ...(id ? [tuning] : []),
      true,
    ];
    let lastErr;
    for (const audio of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        lastErr = err;
        // A refusal by the user or the OS won't change with other settings.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
      }
    }
    throw lastErr;
  }

  async start() {
    if (this.starting) return;
    this.showAlert(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      this.showAlert(micProblem({ name: 'Unsupported' }));
      return;
    }
    // Create the audio engine during the click itself: Chrome only lets it
    // start straight away inside a user gesture.
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.ctx.resume().catch(() => {});
    this.starting = true;
    this.els.toggle.disabled = true;
    this.els.toggle.querySelector('span').textContent = 'Starting…';
    this.els.status.textContent = 'Waiting for microphone permission — choose Allow if your browser asks.';
    try {
      this.stream = await this.openStream();
    } catch (err) {
      this.starting = false;
      this.els.toggle.disabled = false;
      this.els.toggle.querySelector('span').textContent = 'Start listening';
      this.els.status.textContent = 'The microphone is not available — see below.';
      this.ctx.close();
      this.ctx = null;
      this.showAlert(micProblem(err));
      return;
    }
    this.starting = false;
    this.els.toggle.disabled = false;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.5;
    this.source.connect(this.analyser);
    // A silent path to the output keeps every browser pulling audio through
    // the analyser, without playing the microphone back through the speakers.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.analyser.connect(mute);
    mute.connect(this.ctx.destination);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.running = true;
    this.startedAt = performance.now();
    this.loudestDb = -Infinity;
    this.lastSoundAt = 0;
    this.silenceWarned = false;
    this.els.toggle.classList.add('stop');
    this.els.toggle.querySelector('span').textContent = 'Stop';
    this.els.hold.disabled = false;
    this.els.record.disabled = false;
    const track = this.stream.getAudioTracks()[0];
    this.micLabel = (track && track.label) || 'microphone';
    this.els.status.textContent = `Listening · ${this.micLabel}`;
    track.addEventListener('ended', () => {
      if (!this.running) return;
      this.stop();
      this.showAlert({ title: 'The microphone was disconnected', steps: ['Reconnect it, or choose another microphone below, then press Start listening.'] });
    });
    this.listDevices(track);
    const loop = () => {
      if (!this.running) return;
      try {
        this.tick();
      } catch (err) {
        console.error(err);
      }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  // Offers a microphone picker when there is more than one input; Chrome
  // sometimes defaults to a silent one (a webcam mic, "Stereo Mix", …).
  async listDevices(track) {
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
      const current = track.getSettings ? track.getSettings().deviceId : '';
      const sel = this.els.device;
      sel.innerHTML = '';
      inputs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Microphone ${i + 1}`;
        if (d.deviceId === current) o.selected = true;
        sel.appendChild(o);
      });
      sel.parentElement.hidden = inputs.length < 2;
    } catch { /* picker is optional */ }
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
    this.els.hold.textContent = 'Hold';
    this.els.status.textContent = 'Stopped. Tap Start listening to continue.';
    this.els.needle.classList.remove('on');
    if (this.els.alert.classList.contains('warn')) this.showAlert(null);
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
    this.updateSignalStatus(levelDb, now);
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

  // Tells the user what the app hears, so "nothing happens" is never silent.
  updateSignalStatus(levelDb, now) {
    if (levelDb > SILENCE_DB) this.lastSoundAt = now;
    const quietFor = now - Math.max(this.lastSoundAt, this.startedAt);
    if (quietFor > 2000 && !this.silenceWarned) {
      this.silenceWarned = true;
      this.showAlert({
        title: 'No sound is reaching the app',
        steps: [
          `The browser is using "${this.micLabel}". If that is the wrong one, pick another microphone above.`,
          'Check the microphone is not muted (a mute key or switch on the laptop or headset).',
          'Check your system input volume is turned up.',
          'Then sing, hum or say "aaah" close to the microphone.',
        ],
      }, 'warn');
    } else if (this.silenceWarned && quietFor < 100) {
      this.silenceWarned = false;
      this.showAlert(null);
    }
    if (now - (this.statusAt || 0) < 250) return;
    this.statusAt = now;
    let msg;
    if (quietFor > 2000) msg = 'Listening, but the microphone is silent';
    else if (levelDb < -55) msg = 'Listening — too quiet, come closer or sing louder';
    else if (!(this.recent.filter((v) => v > 0).length >= 3)) msg = 'Hearing sound, but no steady pitch — hum or hold "aaah"';
    else msg = `Listening · ${this.micLabel}`;
    this.els.status.textContent = msg;
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
