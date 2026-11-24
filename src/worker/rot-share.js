// rot-share — Cloudflare Worker that keeps images shared from ROT so a share link always shows
// the exact same picture. Deployed at https://rot-share.nicoflp.workers.dev with a KV binding SHOTS.
//
//   POST /i        body = image bytes (webp/jpeg/png, ≤ 2 MB), only from the ROT site → { id }
//   GET  /i/<id>   the stored bytes, immutable, CORS-open
//
// Ids are content hashes, so the same image always gets the same id and a stored image can never
// be replaced. Uploads are rate-limited per IP and kept for one year.

const ALLOWED_ORIGINS = ['https://nicoflp.com', 'https://www.nicoflp.com'];
const TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 365 * 24 * 3600;
const UPLOADS_PER_HOUR = 30;

const cors = origin => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});
const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

// sniff the real format from the first bytes instead of trusting the Content-Type header
function sniff(b) {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

async function idFor(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = btoa(String.fromCharCode(...h.subarray(0, 12)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const m = url.pathname.match(/^\/i\/([A-Za-z0-9_-]{8,32})$/);
    if (req.method === 'GET' && m) {
      const { value, metadata } = await env.SHOTS.getWithMetadata('img:' + m[1], { type: 'arrayBuffer' });
      if (!value) return json({ error: 'not_found' }, 404, origin);
      return new Response(value, {
        headers: {
          'Content-Type': (metadata && metadata.ct) || 'image/webp',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          ...cors(origin)
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/i') {
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
      const len = +req.headers.get('Content-Length') || 0;
      if (len > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
      const ct = sniff(bytes);
      if (!ct || !TYPES.includes(ct)) return json({ error: 'not_an_image' }, 415, origin);

      const id = await idFor(bytes);
      const key = 'img:' + id;
      // already stored (same picture shared twice): no write, no rate-limit cost
      if (await env.SHOTS.get(key, { type: 'stream' })) return json({ id }, 200, origin);

      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const bucket = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600000);
      const used = +(await env.SHOTS.get(bucket)) || 0;
      if (used >= UPLOADS_PER_HOUR) return json({ error: 'rate_limited' }, 429, origin);
      await env.SHOTS.put(bucket, String(used + 1), { expirationTtl: 3700 });

      await env.SHOTS.put(key, bytes, { expirationTtl: TTL, metadata: { ct, at: Date.now() } });
      return json({ id }, 201, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  }
};
