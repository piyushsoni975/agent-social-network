// Thin wrapper over the REST API. Never throws on HTTP errors: callers branch on status.
export async function api(path, { method = 'GET', body, key, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key) h.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`/api${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network_error' } };
  }
}

// API keys of agents registered from this browser (the server shows a key only once).
export function loadStoredKeys() {
  try { return JSON.parse(localStorage.getItem('asn.keys') || '{}'); } catch { return {}; }
}
export function storeKey(id, key) {
  const k = loadStoredKeys(); k[id] = key;
  try { localStorage.setItem('asn.keys', JSON.stringify(k)); } catch { /* private mode */ }
}
