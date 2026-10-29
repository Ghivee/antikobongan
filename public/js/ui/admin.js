// Panel admin: PIN → token sesi (server) → kelola node di tabel nodes.

import { state } from '../store.js';
import { fill, h } from '../dom.js';
import { postJSON, ApiError } from '../api.js';
import { log } from '../log.js';

const TOKEN_KEY = 'antikobongan-admin';

function readToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    return saved && saved.expires_at > Date.now() + 30e3 ? saved.token : null;
  } catch (_) {
    return null;
  }
}

function saveToken(data) {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, expires_at: data.expires_at })); } catch (_) { /* mode privat */ }
}

function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* mode privat */ }
}

function head(dialog, title) {
  return h('div', { class: 'dialog-head' }, h('h2', { id: 'admin-title', text: title }),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Tutup', text: '×', onclick: () => dialog.close() }));
}

function pinView(dialog, onNodes, message) {
  const feedback = h('p', { class: `feedback${message ? ' is-error' : ''}`, hidden: !message, text: message || '' });
  const input = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', name: 'pin', required: true, maxlength: '32' });
  const submit = h('button', { type: 'submit', class: 'btn', text: 'Masuk' });
  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      feedback.hidden = true;
      try {
        const data = await postJSON('/api/admin', { pin: input.value });
        saveToken(data);
        log('Sesi admin dibuka.', 'ok');
        editorView(dialog, onNodes);
      } catch (error) {
        feedback.hidden = false;
        feedback.className = 'feedback is-error';
        feedback.textContent = error.message;
        submit.disabled = false;
        input.select();
      }
    },
  },
  head(dialog, 'Masuk sebagai admin'),
  h('div', { class: 'dialog-body' },
    h('p', { class: 'hint', text: 'PIN diperiksa di server. Sesi berlaku 30 menit di tab ini.' }),
    h('label', { class: 'field' }, h('span', { text: 'PIN admin' }), input),
    feedback),
  h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn btn-ghost', text: 'Batal', onclick: () => dialog.close() }), submit));
  fill(dialog, form);
  setTimeout(() => input.focus(), 0);
}

const FIELDS = [
  { key: 'node_id', label: 'ID node', hint: 'Sama dengan NODE_ID di firmware', required: true },
  { key: 'nama', label: 'Nama tampilan' },
  { key: 'gunung', label: 'Lokasi / kawasan' },
  { key: 'lapisan', label: 'Zona' },
  { key: 'lat', label: 'Lintang', num: true, hint: 'Desimal, mis. -7.3305' },
  { key: 'lon', label: 'Bujur', num: true, hint: 'Desimal, mis. 110.1442' },
  { key: 'ketinggian', label: 'Ketinggian (mdpl)', num: true },
];

function nodeCard(node, index, onRemove) {
  const card = h('fieldset', { class: 'node-card', dataset: { index } },
    h('div', { class: 'node-card-head' }, h('h3', { text: node.node_id || 'Node baru' }),
      h('button', { type: 'button', class: 'link-btn', text: 'Hapus', onclick: () => onRemove(card) })),
    h('div', { class: 'form-grid' }, FIELDS.map((f) => h('label', { class: 'field' },
      h('span', { text: f.label }),
      h('input', {
        name: f.key, value: node[f.key] ?? '', required: f.required || null, inputmode: f.num ? 'decimal' : null,
        placeholder: f.hint || null, autocomplete: 'off', spellcheck: 'false',
      })))));
  return card;
}

function readCards(container) {
  return [...container.querySelectorAll('.node-card')].map((card) => {
    const out = { aktif: true };
    for (const f of FIELDS) {
      const raw = card.querySelector(`[name="${f.key}"]`).value.trim();
      out[f.key] = f.num ? (raw === '' ? null : Number(raw.replace(',', '.'))) : raw || null;
    }
    return out;
  });
}

function editorView(dialog, onNodes) {
  const token = readToken();
  if (!token) {
    pinView(dialog, onNodes);
    return;
  }
  const list = h('div', { class: 'dialog-body' });
  const feedback = h('p', { class: 'feedback', hidden: true });
  const remove = (card) => {
    card.remove();
    if (!list.querySelector('.node-card')) list.append(nodeCard({}, 0, remove));
  };
  const nodes = state.nodes.filter((n) => n.aktif !== false);
  (nodes.length ? nodes : [{}]).forEach((node, i) => list.append(nodeCard(node, i, remove)));
  const save = h('button', { type: 'submit', class: 'btn', text: 'Simpan ke server' });

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      save.disabled = true;
      feedback.hidden = true;
      try {
        const data = await postJSON('/api/nodes', { nodes: readCards(list) }, { token: readToken() });
        onNodes(data);
        feedback.className = 'feedback is-ok';
        feedback.textContent = 'Tersimpan. Semua pengguna dasbor kini melihat daftar node ini.';
        log('Konfigurasi node disimpan ke server.', 'ok');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          clearToken();
          pinView(dialog, onNodes, error.message);
          return;
        }
        feedback.className = 'feedback is-error';
        feedback.textContent = error.message;
      } finally {
        feedback.hidden = false;
        save.disabled = false;
      }
    },
  },
  head(dialog, 'Kelola node'),
  h('div', { class: 'dialog-body' },
    h('p', { class: 'hint', text: 'Disimpan di tabel nodes (Supabase) dan berlaku untuk semua pengguna. Node yang dihapus dinonaktifkan; riwayatnya tetap tersimpan.' })),
  list,
  h('div', { class: 'dialog-body' }, h('button', { type: 'button', class: 'btn btn-ghost', text: 'Tambah node', onclick: () => list.append(nodeCard({}, list.childElementCount, remove)) }), feedback),
  h('div', { class: 'dialog-foot' },
    h('button', { type: 'button', class: 'btn btn-ghost', text: 'Keluar sesi', onclick: () => { clearToken(); dialog.close(); } }),
    save));
  fill(dialog, form);
}

export function openAdmin(dialog, onNodes) {
  editorView(dialog, onNodes);
  if (!dialog.open) dialog.showModal();
}
