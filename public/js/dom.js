// Pembuat elemen yang aman: teks selalu lewat textContent, tidak ada innerHTML.

export const $ = (selector, root = document) => root.querySelector(selector);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// Nilai yang dipakai sebagai nama class wajib lolos daftar putih.
export function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function lvClass(level) {
  return `lv-${pick(level, ['NORMAL', 'SEDANG', 'TINGGI', 'KRITIS'], 'none')}`;
}

export function mark(level, label) {
  return h('span', { class: `lv-mark ${lvClass(level)}`, role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true' });
}
