import { analyse } from './analysis.js';

self.onmessage = (event) => {
  const { id, channels, sampleRate } = event.data;
  try {
    const result = analyse({ channels, sampleRate }, (progress, stage) => {
      self.postMessage({ id, type: 'progress', progress, stage });
    });
    const s = result.spectrograms;
    const transfer = [
      result.stems.vocal.buffer,
      result.stems.instL.buffer,
      s.mix.data.buffer, s.vocal.data.buffer, s.inst.data.buffer,
    ];
    if (result.stems.instR !== result.stems.instL) transfer.push(result.stems.instR.buffer);
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
