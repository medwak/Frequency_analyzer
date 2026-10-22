// File / recording analysis view: decode, analyse in a worker, play stems.

import { frequencyToNote, wavelength, formatFrequency, formatLength } from './dsp.js';
import {
  drawSpectrogram, drawContour, drawWaveform, drawAverageSpectrum, renderHarmonics,
  formatTime, invLogScale,
} from './charts.js';
import { encodeWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const STEM_COLOR = { mix: '--series-1', vocal: '--series-2', inst: '--series-3' };
const STEM_NAME = { mix: 'full-mix', vocal: 'vocals', inst: 'instrumental' };

function noteText(f, a4) {
  const n = frequencyToNote(f, a4);
  return n ? `${n.label}${n.cents ? ` ${n.cents > 0 ? '+' : ''}${n.cents}¢` : ''}` : '—';
}

function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

export class FileAnalyser {
  constructor(settings) {
    this.settings = settings;
    this.result = null;
    this.stem = 'mix';
    this.specKind = 'mix';
    this.playing = false;
    this.offset = 0;
    this.jobId = 0;

    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.analyse(f, f.name);
      e.target.value = '';
    });
    const dz = $('dropzone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.analyse(f, f.name);
    });

    document.querySelectorAll('.player .seg').forEach((b) => b.addEventListener('click', () => this.selectStem(b.dataset.stem)));
    document.querySelectorAll('#spec-tabs .seg').forEach((b) => b.addEventListener('click', () => {
      this.specKind = b.dataset.spec;
      document.querySelectorAll('#spec-tabs .seg').forEach((x) => x.classList.toggle('active', x === b));
      this.marker = null;
      $('spec-readout').textContent = 'Tap to read a point';
      this.drawTimeCharts();
    }));
    $('play-btn').addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    $('download-btn').addEventListener('click', () => this.download());
    $('res-wave').addEventListener('pointerdown', (e) => this.seekFromEvent(e));
    $('res-spectrogram').addEventListener('pointerdown', (e) => this.readSpectrogram(e));
    const avg = $('res-avg');
    avg.addEventListener('pointermove', (e) => this.readAverage(e));
    avg.addEventListener('pointerdown', (e) => this.readAverage(e));
    avg.addEventListener('pointerleave', () => { this.avgHover = null; this.drawAverage(); $('avg-readout').textContent = ''; });
  }

  get ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  }

  showError(msg) {
    const el = $('file-error');
    el.textContent = msg;
    el.hidden = !msg;
  }

  setProgress(p, stage) {
    $('progress-bar').style.width = `${Math.round(p * 100)}%`;
    $('progress-pct').textContent = `${Math.round(p * 100)}%`;
    if (stage) $('progress-stage').textContent = stage;
  }

  async analyse(blob, name) {
    const id = ++this.jobId;
    this.pause();
    this.showError('');
    $('file-results').hidden = true;
    $('file-progress').hidden = false;
    $('progress-title').textContent = `Analysing ${name}`;
    this.setProgress(0.02, 'Decoding audio');
    let buffer;
    try {
      buffer = await decode(this.ctx, await blob.arrayBuffer());
    } catch (err) {
      $('file-progress').hidden = true;
      this.showError('This file could not be decoded. Try an MP3, WAV, M4A/AAC, OGG or FLAC file.');
      return;
    }
    if (id !== this.jobId) return;
    if (buffer.duration < 0.15) {
      $('file-progress').hidden = true;
      this.showError('The recording is too short to analyse.');
      return;
    }
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());

    if (this.worker) this.worker.terminate();
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const result = await new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'progress') this.setProgress(0.05 + data.progress * 0.95, data.stage);
        else if (data.type === 'result') resolve(data.result);
        else if (data.type === 'error') reject(new Error(data.message));
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Analysis failed'));
      this.worker.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    }).catch((err) => {
      if (id === this.jobId) {
        $('file-progress').hidden = true;
        this.showError(`Analysis failed: ${err.message}`);
      }
      return null;
    });
    if (!result || id !== this.jobId) return;
    this.worker.terminate();
    this.worker = null;

    const sr = buffer.sampleRate;
    const n = result.stems.vocal.length;
    const vocalBuf = this.ctx.createBuffer(1, n, sr);
    vocalBuf.copyToChannel(result.stems.vocal, 0);
    const instBuf = this.ctx.createBuffer(2, n, sr);
    instBuf.copyToChannel(result.stems.instL, 0);
    instBuf.copyToChannel(result.stems.instR, 1);
    this.buffers = { mix: buffer, vocal: vocalBuf, inst: instBuf };
    this.waves = { mix: buffer.getChannelData(0), vocal: result.stems.vocal, inst: result.stems.instL };
    this.result = result;
    this.name = name;
    this.offset = 0;
    this.marker = null;
    $('file-progress').hidden = true;
    $('file-results').hidden = false;
    this.render();
  }

  render() {
    const r = this.result;
    if (!r) return;
    const { a4, tempC } = this.settings;
    const m = r.meta;
    $('res-name').textContent = this.name;
    $('res-meta').textContent = `${(m.sampleRate / 1000).toFixed(1)} kHz · ${m.channels === 1 ? 'mono' : 'stereo'}`;
    $('res-duration').textContent = formatTime(m.duration);
    const key = r.instrumental.key;
    $('res-key').innerHTML = key ? `${key.name}${key.confidence < 0.35 ? ' <small>(weak)</small>' : ''}` : '—';
    const tempo = r.instrumental.tempo;
    $('res-tempo').innerHTML = tempo ? `${Math.round(tempo.bpm)} <small>BPM${tempo.confidence < 0.3 ? ' (weak)' : ''}</small>` : '—';
    $('res-loudness').innerHTML = `${r.loudness.rmsDb.toFixed(1)} <small>dBFS RMS</small>`;
    $('res-truncated').hidden = !m.truncated;

    // Overall sound
    const s = r.sound;
    $('sound-at').textContent = s ? `measured at ${formatTime(s.time)}` : '';
    $('sound-f0').textContent = s && s.f0 > 0 ? formatFrequency(s.f0) : 'no clear pitch';
    $('sound-note').textContent = s && s.f0 > 0 ? noteText(s.f0, a4) : '—';
    $('sound-wavelength').textContent = s && s.f0 > 0 ? formatLength(wavelength(s.f0, tempC)) : '—';
    $('sound-period').innerHTML = s && s.f0 > 0 ? `${(1000 / s.f0).toFixed(2)} <small>ms</small>` : '—';
    $('sound-dominant').textContent = s ? formatFrequency(s.dominant) : '—';
    $('sound-dominant-wl').textContent = s ? formatLength(wavelength(s.dominant, tempC)) : '—';
    if (s && s.formants && s.vowel) {
      const fm = s.formants;
      $('sound-vowel').textContent = `Closest vowel /${s.vowel.ipa}/ — ${s.vowel.label}${s.vowel.confidence < 0.3 ? ' (unsure)' : ''}. Formants F1 ${Math.round(fm.f1)} Hz, F2 ${fm.f2 > 0 ? Math.round(fm.f2) : '—'} Hz${fm.f3 > 0 ? `, F3 ${Math.round(fm.f3)} Hz` : ''}.`;
    } else {
      $('sound-vowel').textContent = 'No vowel-like resonances found at this moment.';
    }
    renderHarmonics($('sound-harmonics'), s ? s.harmonics : []);

    // Vocals
    const v = r.vocal;
    const vp = v.pitch;
    $('voc-detected').textContent = v.detected
      ? `present in ${Math.round(v.presence * 100)}% of the track`
      : 'little or no singing detected';
    if (v.detected && vp) {
      $('voc-median').innerHTML = `${formatFrequency(vp.median)} <small>${noteText(vp.median, a4)}</small>`;
      const lo = frequencyToNote(vp.low, a4);
      const hi = frequencyToNote(vp.high, a4);
      $('voc-range').innerHTML = `${lo.label}–${hi.label} <small>${(vp.rangeSemitones / 12).toFixed(1)} oct</small>`;
      $('voc-type').textContent = v.voiceType || '—';
      $('voc-wavelength').textContent = formatLength(wavelength(vp.median, tempC));
    } else {
      for (const id of ['voc-median', 'voc-range', 'voc-type', 'voc-wavelength']) $(id).textContent = '—';
    }

    // Instrumental
    const inst = r.instrumental;
    const hPct = Math.round(inst.harmonicRatio * 100);
    const hp = $('inst-hp');
    hp.children[0].style.flex = `${inst.harmonicRatio}`;
    hp.children[1].style.flex = `${1 - inst.harmonicRatio}`;
    $('inst-h').textContent = `Pitched ${hPct}%`;
    $('inst-p').textContent = `Percussive ${100 - hPct}%`;
    $('inst-profile').innerHTML = inst.profile.map((p) => `<li>${p}</li>`).join('');

    // Bands
    const bands = $('res-bands');
    const max = Math.max(...r.bands.vocal, ...r.bands.inst, 1e-9);
    bands.innerHTML = r.bands.names.map((name, i) => {
      const vv = r.bands.vocal[i];
      const ii = r.bands.inst[i];
      return `<div class="name">${name}</div><div class="pair" title="${name}: vocals ${(vv * 100).toFixed(1)}%, instrumental ${(ii * 100).toFixed(1)}%">
        <div style="display:flex;align-items:center;gap:6px"><div class="b v" style="width:${(vv / max) * 85}%"></div><span class="val">${(vv * 100).toFixed(0)}%</span></div>
        <div style="display:flex;align-items:center;gap:6px"><div class="b i" style="width:${(ii / max) * 85}%"></div><span class="val">${(ii * 100).toFixed(0)}%</span></div>
      </div>`;
    }).join('');

    this.updateTime();
    this.drawAverage();
  }

  // ---------------------------------------------------------- charts

  playheadFraction() {
    return this.result ? Math.min(1, this.currentTime() / this.result.meta.duration) : 0;
  }

  drawTimeCharts() {
    if (!this.result || $('file-results').hidden) return;
    const ph = this.playheadFraction();
    drawWaveform($('res-wave'), this.waves[this.stem], STEM_COLOR[this.stem], ph);
    this.specPad = drawSpectrogram($('res-spectrogram'), this.result.spectrograms[this.specKind], this.result.meta.duration, ph, this.marker);
    drawContour($('voc-contour'), this.result.vocal.track, this.result.meta.duration, this.settings.a4, ph);
  }

  drawAverage() {
    if (!this.result || $('file-results').hidden) return;
    this.avgGeom = drawAverageSpectrum($('res-avg'), this.result.avgSpectrum, this.avgHover);
  }

  redraw() {
    this.drawTimeCharts();
    this.drawAverage();
  }

  readSpectrogram(e) {
    if (!this.result || !this.specPad) return;
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pad = this.specPad;
    const w = rect.width;
    const h = rect.height;
    if (x < pad.l || x > w - pad.r || y < pad.t || y > h - pad.b) return;
    const spec = this.result.spectrograms[this.specKind];
    const t = ((x - pad.l) / (w - pad.l - pad.r)) * this.result.meta.duration;
    const f = invLogScale(y, spec.fMin, spec.fMax, h - pad.b, pad.t);
    const col = Math.min(spec.cols - 1, Math.floor(((x - pad.l) / (w - pad.l - pad.r)) * spec.cols));
    const row = Math.min(spec.rows - 1, Math.floor(((h - pad.b - y) / (h - pad.t - pad.b)) * spec.rows));
    const db = spec.data[col * spec.rows + row];
    this.marker = { x, y };
    $('spec-readout').textContent = `${formatTime(t)} · ${formatFrequency(f)} (${noteText(f, this.settings.a4)}) · λ ${formatLength(wavelength(f, this.settings.tempC))} · ${db.toFixed(0)} dB`;
    this.drawTimeCharts();
  }

  readAverage(e) {
    if (!this.result || !this.avgGeom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { fMin, fMax, pad } = this.avgGeom;
    const f = invLogScale(Math.max(pad.l, Math.min(rect.width - pad.r, x)), fMin, fMax, pad.l, rect.width - pad.r);
    const avg = this.result.avgSpectrum;
    let i = 0;
    while (i < avg.freqs.length - 1 && avg.freqs[i] < f) i++;
    this.avgHover = x;
    $('avg-readout').textContent = `${formatFrequency(avg.freqs[i])}: mix ${avg.mix[i].toFixed(0)}, vocals ${avg.vocal[i].toFixed(0)}, instr. ${avg.inst[i].toFixed(0)} dB`;
    this.drawAverage();
  }

  // --------------------------------------------------------- playback

  currentTime() {
    if (this.playing) return this.offset + (this.ctx.currentTime - this.startedAt);
    return this.offset;
  }

  updateTime() {
    if (!this.result) return;
    $('play-time').textContent = `${formatTime(this.currentTime())} / ${formatTime(this.result.meta.duration)}`;
    this.drawTimeCharts();
  }

  play() {
    if (!this.buffers) return;
    this.ctx.resume();
    if (this.offset >= this.buffers.mix.duration - 0.05) this.offset = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[this.stem];
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.source !== src) return;
      this.offset = this.currentTime();
      this.playing = false;
      this.source = null;
      this.setPlayIcon();
      if (this.offset >= this.buffers.mix.duration - 0.1) this.offset = 0;
      this.updateTime();
    };
    src.start(0, this.offset);
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
    this.setPlayIcon();
    const loop = () => {
      if (!this.playing) return;
      this.updateTime();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime();
    this.playing = false;
    const src = this.source;
    this.source = null;
    try { src.stop(); } catch { /* already stopped */ }
    cancelAnimationFrame(this.raf);
    this.setPlayIcon();
    this.updateTime();
  }

  setPlayIcon() {
    $('play-icon').innerHTML = this.playing
      ? '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>'
      : '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    $('play-btn').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }

  selectStem(stem) {
    this.stem = stem;
    document.querySelectorAll('.player .seg').forEach((b) => b.classList.toggle('active', b.dataset.stem === stem));
    if (this.playing) {
      this.pause();
      this.play();
    } else {
      this.updateTime();
    }
  }

  seekFromEvent(e) {
    if (!this.result) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const wasPlaying = this.playing;
    this.pause();
    this.offset = frac * this.result.meta.duration;
    if (wasPlaying) this.play(); else this.updateTime();
  }

  async download() {
    if (!this.buffers) return;
    const b = this.buffers[this.stem];
    const chans = [];
    for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
    const blob = encodeWav(chans, b.sampleRate);
    const base = this.name.replace(/\.[^.]+$/, '');
    const filename = `${base}-${STEM_NAME[this.stem]}.wav`;
    const file = new File([blob], filename, { type: 'audio/wav' });
    // On phones the share sheet is the natural way to save or send a file.
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
