// ============================================================
// 共享 API 客户端
// ============================================================
const API = {
  token: localStorage.getItem('token') || '',
  base: '/api',

  setToken(t) { this.token = t; if (t) localStorage.setItem('token', t); else localStorage.removeItem('token'); },

  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(this.base + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) { this.setToken(''); window.location.hash = '#login'; }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },
  get: (p) => API.request('GET', p),
  post: (p, b) => API.request('POST', p, b),
  put: (p, b) => API.request('PUT', p, b),
  del: (p) => API.request('DELETE', p),

  async upload(path, file, fields = {}) {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: this.token ? { 'Authorization': 'Bearer ' + this.token } : {},
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get isLoggedIn() { return !!this.token; },
  get user() { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } },
  set user(u) { localStorage.setItem('user', JSON.stringify(u)); },
};
