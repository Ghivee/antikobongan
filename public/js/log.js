// Log teknis untuk laci Diagnostik (maks 200 baris, hanya di memori).

const MAX = 200;
const entries = [];
const listeners = new Set();

export function log(message, level = 'info') {
  entries.unshift({ at: Date.now(), level, message: String(message).slice(0, 500) });
  if (entries.length > MAX) entries.length = MAX;
  listeners.forEach((fn) => fn());
}

export const logEntries = () => entries;
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
