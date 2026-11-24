// rot-share — Cloudflare Worker that keeps images shared from ROT so a share link always shows
// the exact same picture. Deployed at https://rot-share.nicoflp.workers.dev with a KV binding SHOTS
// and (optional) a rate-limit binding RL.
//
//   POST /i        body = a WebP made by the ROT generator (≤ 400 KB, ≤ 1152 px) → { id }
//   GET  /i/<id>   the stored bytes, immutable, CORS-open
//
// Ids are content hashes, so the same image always gets the same id and a stored image can never
// be replaced. Abuse limits: only well-formed WebP of the generator's size, a short per-network
// burst limit, and a daily budget (count and bytes) that keeps the free KV quota safe. When a limit
// is hit the site still works: the link falls back to redrawing the image.

const ALLOWED_ORIGINS = ['https://nicoflp.com', 'https://www.nicoflp.com'];
const MAX_BYTES = 400 * 1024;
const MAX_SIDE = 1152, MIN_SIDE = 64;
const TTL = 180 * 24 * 3600;           // older links fall back to redrawing
const DAY_MAX_UPLOADS = 200;            // 2 KV writes each → ≤ 400 of the 1000 free writes/day
const DAY_MAX_BYTES = 5 * 1024 * 1024;   // × 180 days ≤ ~0.9 GB, inside the free 1 GB

const cors = origin => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});
const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

// Read the body but stop as soon as it exceeds the limit (chunked uploads have no Content-Length).
async function readCapped(req, max) {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader(), parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (e) {} return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A complete, well-formed WebP (RIFF size matches the body) with sane dimensions, or null.
function webpSize(b) {
  const tag = (i, s) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) === s;
  if (b.length < 30 || !tag(0, 'RIFF') || !tag(8, 'WEBP')) return null;
  const riff = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
  if (riff + 8 !== b.length) return null;
  let w = 0, h = 0;
  if (tag(12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    w = (b[26] | b[27] << 8) & 0x3fff; h = (b[28] | b[29] << 8) & 0x3fff;
  } else if (tag(12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const v = (b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24) >>> 0;
    w = (v & 0x3fff) + 1; h = ((v >>> 14) & 0x3fff) + 1;
  } else if (tag(12, 'VP8X')) {
    w = (b[24] | b[25] << 8 | b[26] << 16) + 1; h = (b[27] | b[28] << 8 | b[29] << 16) + 1;
  } else return null;
  if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) return null;
  return { w, h };
}

async function idFor(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = btoa(String.fromCharCode(...h.subarray(0, 12)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// IPv6 users get a whole /64 each, so limit per /64 instead of per address.
function netKey(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const m = url.pathname.match(/^\/i\/([A-Za-z0-9_-]{8,32})$/);
    if (req.method === 'GET' && m) {
      const value = await env.SHOTS.get('img:' + m[1], { type: 'arrayBuffer' });
      if (!value) return json({ error: 'not_found' }, 404, origin);
      return new Response(value, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          ...cors(origin)
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/i') {
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
      if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
      if (env.RL) {
        const { success } = await env.RL.limit({ key: netKey(req.headers.get('CF-Connecting-IP')) });
        if (!success) return json({ error: 'rate_limited' }, 429, origin);
      }
      const bytes = await readCapped(req, MAX_BYTES);
      if (!bytes) return json({ error: 'too_large' }, 413, origin);
      if (!webpSize(bytes)) return json({ error: 'not_an_image' }, 415, origin);

      const id = await idFor(bytes);
      const key = 'img:' + id;
      // already stored (same picture shared twice): no write, no budget cost
      if (await env.SHOTS.get(key, { type: 'stream' })) return json({ id }, 200, origin);

      const dayKey = 'day:' + new Date().toISOString().slice(0, 10);
      const day = (await env.SHOTS.get(dayKey, { type: 'json' })) || { n: 0, b: 0 };
      if (day.n >= DAY_MAX_UPLOADS || day.b + bytes.length > DAY_MAX_BYTES) return json({ error: 'budget' }, 429, origin);
      await env.SHOTS.put(dayKey, JSON.stringify({ n: day.n + 1, b: day.b + bytes.length }), { expirationTtl: 2 * 86400 });

      await env.SHOTS.put(key, bytes, { expirationTtl: TTL, metadata: { at: Date.now() } });
      return json({ id }, 201, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  }
};
