import { speedOfSound } from './dsp.js';
import { LiveAnalyser } from './live.js';
import { FileAnalyser } from './file.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ settings

const settings = { a4: 440, tempC: 20 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('fa-settings') || '{}'));
} catch { /* storage unavailable: keep defaults */ }

function saveSettings() {
  try { localStorage.setItem('fa-settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

const a4Input = $('set-a4');
const tempInput = $('set-temp');
function showSpeed() {
  $('set-speed').textContent = `Speed of sound at ${settings.tempC} °C: ${speedOfSound(settings.tempC).toFixed(1)} m/s`;
}
a4Input.value = settings.a4;
tempInput.value = settings.tempC;
showSpeed();
a4Input.addEventListener('input', () => {
  const v = Number(a4Input.value);
  if (v >= 400 && v <= 480) { settings.a4 = v; saveSettings(); file.render(); }
});
tempInput.addEventListener('input', () => {
  const v = Number(tempInput.value);
  if (v >= -30 && v <= 50) { settings.tempC = v; saveSettings(); showSpeed(); file.render(); }
});
$('settings-btn').addEventListener('click', () => $('settings').showModal());

// ---------------------------------------------------------------- views

const file = new FileAnalyser(settings);
const live = new LiveAnalyser(settings, {
  onRecording: (blob) => {
    showView('file');
    file.analyse(blob, `Recording ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  },
  onError: (msg) => { $('live-status').textContent = msg; },
});

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  live.setVisible(name === 'live');
  if (name === 'file') requestAnimationFrame(() => file.redraw());
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    file.redraw();
    if (!live.running) live.drawIdle();
  }, 120);
});
// Redraw canvases when the OS theme flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  file.redraw();
  if (!live.running) live.drawIdle();
});

// Cache the app shell so it installs and works offline.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.__app = { live, file, settings, showView };
