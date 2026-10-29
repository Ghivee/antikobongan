// Tata letak yang diatur pengguna: seret garis pembatas antarpanel (mouse,
// sentuh, atau tombol panah saat pembatas difokus). Ukuran disimpan sebagai
// proporsi, bukan piksel, sehingga tetap pas saat jendela di-zoom atau diubah.

const KEY = 'antikobongan-layout';
const STEP = 0.02;

// host: elemen acuan ukuran. axis x = lebar, y = tinggi.
// apply(v) mengubah variabel CSS di host; v = proporsi 0..1.
const SPECS = {
  sidebar: {
    host: '#body', axis: 'x', min: 0.12, max: 0.5, label: 'Lebar kolom samping',
    value: (r, e) => (r.right - e.clientX) / r.width,
    css: (v) => ({ '--sidebar': `min(max(260px, ${(v * 100).toFixed(2)}%), calc(100% - 520px))` }),
  },
  risk: {
    host: '#mid', axis: 'x', min: 0.18, max: 0.65, label: 'Lebar panel indeks risiko',
    value: (r, e) => (e.clientX - r.left) / r.width,
    css: (v) => ({ '--risk-col': `min(max(220px, ${(v * 100).toFixed(2)}%), calc(100% - 300px))` }),
  },
  metrics: {
    host: '#col-main', axis: 'y', min: 0.08, max: 0.4, label: 'Tinggi kartu sensor',
    // Sisakan minimal 440 px untuk panel tengah + peta.
    value: (r, e) => Math.min(e.clientY - r.top, r.height - 440) / r.height,
    css: (v) => ({ '--met-row': `minmax(min-content, ${(v * 100).toFixed(2)}%)` }),
  },
  rows: {
    host: '#col-main', axis: 'y', min: 0.2, max: 0.85, label: 'Pembagian grafik dan peta',
    // Proporsi tinggi panel tengah terhadap panel tengah + peta.
    value: (_r, e) => {
      const mid = document.querySelector('#mid').getBoundingClientRect();
      const map = document.querySelector('#map-section').getBoundingClientRect();
      const total = map.bottom - mid.top;
      // Panel tengah minimal 260 px, peta minimal 170 px.
      return Math.min(Math.max(e.clientY - mid.top, 260), total - 170) / total;
    },
    css: (v) => ({ '--mid-fr': `${(v * 100).toFixed(2)}fr`, '--map-fr': `${((1 - v) * 100).toFixed(2)}fr` }),
  },
  nodes: {
    host: '#sidebar', axis: 'y', min: 0.06, max: 0.6, label: 'Tinggi daftar node',
    value: (_r, e) => (e.clientY - document.querySelector('#node-groups').getBoundingClientRect().top) / window.innerHeight,
    css: (v) => ({ '--nodes-h': `${(v * 100).toFixed(2)}vh` }),
  },
};

let saved = {};

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
}
function write() {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (_) { /* mode privat */ }
}

const clamp = (v, spec) => Math.min(spec.max, Math.max(spec.min, v));

function apply(name, v) {
  const spec = SPECS[name];
  const host = document.querySelector(spec.host);
  for (const [prop, val] of Object.entries(spec.css(v))) host.style.setProperty(prop, val);
  const handle = document.querySelector(`[data-split="${name}"]`);
  if (handle) handle.setAttribute('aria-valuenow', String(Math.round(v * 100)));
}

function clear(name) {
  const spec = SPECS[name];
  const host = document.querySelector(spec.host);
  for (const prop of Object.keys(spec.css(0.5))) host.style.removeProperty(prop);
  const handle = document.querySelector(`[data-split="${name}"]`);
  if (handle) handle.removeAttribute('aria-valuenow');
  delete saved[name];
}

// Nilai sekarang (dari ukuran nyata) sebagai titik awal untuk keyboard.
function measure(name) {
  const handle = document.querySelector(`[data-split="${name}"]`).getBoundingClientRect();
  const spec = SPECS[name];
  const host = document.querySelector(spec.host).getBoundingClientRect();
  const center = { clientX: handle.left + handle.width / 2, clientY: handle.top + handle.height / 2 };
  return spec.value(host, center);
}

function bindHandle(handle, onChange) {
  const name = handle.dataset.split;
  const spec = SPECS[name];
  handle.setAttribute('role', 'separator');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-orientation', spec.axis === 'x' ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-label', spec.label);
  handle.setAttribute('aria-valuemin', String(Math.round(spec.min * 100)));
  handle.setAttribute('aria-valuemax', String(Math.round(spec.max * 100)));
  handle.title = `${spec.label}: seret untuk mengubah · klik ganda untuk ukuran bawaan`;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('is-resizing', `is-resizing-${spec.axis}`);
    handle.classList.add('is-active');
    const host = document.querySelector(spec.host);
    const move = (e) => {
      const v = clamp(spec.value(host.getBoundingClientRect(), e), spec);
      saved[name] = v;
      apply(name, v);
      onChange();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('is-resizing', `is-resizing-${spec.axis}`);
      handle.classList.remove('is-active');
      write();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { clear(name); write(); onChange(); });
  handle.addEventListener('keydown', (event) => {
    const keys = spec.axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    let dir = keys[event.key];
    if (event.key === 'Home') dir = -100;
    if (event.key === 'End') dir = 100;
    if (!dir) return;
    event.preventDefault();
    // Kolom samping diukur dari kanan: panah kiri justru melebarkannya.
    const sign = name === 'sidebar' ? -1 : 1;
    const base = saved[name] ?? measure(name);
    const v = clamp(base + dir * sign * STEP, spec);
    saved[name] = v;
    apply(name, v);
    write();
    onChange();
  });
}

export function initLayout(onChange) {
  saved = read();
  for (const [name, v] of Object.entries(saved)) {
    if (SPECS[name] && Number.isFinite(v)) apply(name, clamp(v, SPECS[name]));
    else delete saved[name];
  }
  document.querySelectorAll('[data-split]').forEach((handle) => {
    if (SPECS[handle.dataset.split]) bindHandle(handle, onChange);
  });
}

export function resetLayout() {
  for (const name of Object.keys(SPECS)) clear(name);
  saved = {};
  try { localStorage.removeItem(KEY); } catch (_) { /* mode privat */ }
}

export const hasCustomLayout = () => Object.keys(saved).length > 0;
