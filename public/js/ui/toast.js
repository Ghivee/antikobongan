import { $, h, lvClass } from '../dom.js';

export function toast({ level, title, text, sticky = false }) {
  const zone = $('#toasts');
  const close = () => el.remove();
  const el = h('div', { class: `toast ${lvClass(level)}` },
    h('strong', { text: title }),
    h('button', { type: 'button', 'aria-label': 'Tutup', text: '×', onclick: close }),
    text && h('p', { text }));
  zone.prepend(el);
  while (zone.childElementCount > 3) zone.lastElementChild.remove();
  if (!sticky) setTimeout(close, 12000);
}
