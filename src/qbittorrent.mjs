import { fail } from './store.mjs';

export function createQbitClient(config, fetchImpl = fetch) {
  let cookie = '',
    login;
  const base = String(config.qbitUrl || '').replace(/\/$/, '');
  async function signIn() {
    if (!base) fail(503, 'qBittorrent is not configured');
    const r = await fetchImpl(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { Referer: base + '/' },
      body: new URLSearchParams({ username: config.qbitUsername, password: config.qbitPassword }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const body = (await r.text()).trim();
    if (!r.ok || (r.status !== 204 && body !== 'Ok.'))
      fail(503, 'qBittorrent login failed. Check its server configuration.');
    cookie = r.headers.get('set-cookie')?.split(';')[0] || '';
    if (!cookie) fail(503, 'qBittorrent did not establish a session');
  }
  async function call(endpoint, data, retried = false) {
    if (!cookie) {
      login ||= signIn().finally(() => {
        login = null;
      });
      await login;
    }
    const query = (data && endpoint.endsWith('/info')) || (data && endpoint.endsWith('/files'));
    const url = `${base}/api/v2/${endpoint}${query ? '?' + new URLSearchParams(data) : ''}`;
    const r = await fetchImpl(url, {
      method: !data || query ? 'GET' : 'POST',
      headers: { Cookie: cookie, Referer: base + '/' },
      body:
        data && !query ? (data instanceof FormData ? data : new URLSearchParams(data)) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 403 && !retried) {
      cookie = '';
      return call(endpoint, data, true);
    }
    if (!r.ok)
      fail(
        r.status >= 500 || r.status === 403 ? 503 : 502,
        `qBittorrent ${endpoint.split('/').pop()} failed (HTTP ${r.status})`,
      );
    return r.headers.get('content-type')?.includes('application/json') ? r.json() : r.text();
  }
  return {
    call,
    async info(hash) {
      return (await call('torrents/info', { hashes: hash }))[0];
    },
    files: (hash) => call('torrents/files', { hash }),
    stop: (hash) => call('torrents/stop', { hashes: hash }),
    start: (hash) => call('torrents/start', { hashes: hash }),
    async health() {
      return { connected: true, version: await call('app/version') };
    },
  };
}
