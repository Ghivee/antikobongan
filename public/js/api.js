// Klien API: satu pintu fetch dengan batas waktu dan pembatalan.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(path, { method = 'GET', body, token, timeout = 15000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) throw new ApiError((data && data.error) || `Server menjawab HTTP ${response.status}.`, response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal && signal.aborted) throw error;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new ApiError('Server tidak merespons tepat waktu.', 0);
    throw new ApiError('Tidak dapat menghubungi server.', 0);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export const getJSON = (path, options) => call(path, options);
export const postJSON = (path, body, options = {}) => call(path, { ...options, method: 'POST', body });
