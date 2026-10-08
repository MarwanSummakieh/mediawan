import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  // Only global unicast IPv6. Also excludes mapped IPv4 and NAT64 addresses.
  return !/^[23][0-9a-f]{3}:/i.test(ip) || /^2001:(?:db8|0|10|20):/i.test(ip) || /^2002:/i.test(ip);
}
export async function openLiveStream(raw, { signal, headers = {} } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error('Invalid provider URL');
  }
  for (let redirect = 0; redirect < 6; redirect++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Error('Use an HTTP or HTTPS provider URL without embedded user information');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => privateIp(a.address)))
      throw Error('Provider URLs must resolve to a public address');
    const chosen = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          signal,
          headers: { 'User-Agent': 'Mediawan/2.0', ...headers },
          // Pin the checked address so a second DNS lookup cannot reach the LAN.
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
        },
        resolve,
      );
      request.on('error', () => reject(Error('The live TV provider did not respond')));
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw Error('Invalid provider redirect');
      url = new URL(location, url);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw Error('The provider could not serve this resource');
    }
    return { response, url: url.href };
  }
  throw Error('The provider redirected too many times');
}
export async function fetchLiveResource(
  url,
  { maxBytes = 120 * 1024 * 1024, timeoutMs = 60000 } = {},
) {
  const { response } = await openLiveStream(url, { signal: AbortSignal.timeout(timeoutMs) });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) throw Error('Provider response exceeds the size limit');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks) };
  } finally {
    response.destroy();
  }
}
