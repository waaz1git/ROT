// rot-share — Cloudflare Worker behind ROT's share links. Deployed at https://rot-share.nicoflp.workers.dev
// with a KV binding SHOTS and (optional) a rate-limit binding RL;
// share links use the custom domain https://s.nicoflp.com/<id>#rot=….
//
//   POST /i            a WebP made by the ROT generator (≤ 400 KB, ≤ 1152 px) → { id }   (content hash)
//   GET  /i/<id>       the stored image, immutable
//   PUT  /p/<id>       a 1200×630 JPEG frame of a shared look (id chosen by the client, write-once)
//   GET  /p/<id>       that frame
//   GET  /<id>, /s/<id> a tiny page whose link preview (og:image) is that frame; it forwards the visitor
//                      to https://nicoflp.com/ keeping the #rot=… part of the address
//   GET  /g            the public gallery (newest first)
//   POST /g            { img, p, l } publish a generated-image look to the gallery
//   POST /g/report     { id } — three reports hide an entry
//
// Abuse limits: only well-formed images of the exact kinds ROT makes, a per-network burst limit, and
// daily budgets (count and bytes) that keep the free KV quota safe. When a limit is hit the site still
// works: links fall back to redrawing, previews to the default card.

const SITE = 'https://nicoflp.com';
const ALLOWED_ORIGINS = [SITE, 'https://www.nicoflp.com'];
const MAX_BYTES = 400 * 1024;                 // generated WebP
const MAX_PREVIEW = 220 * 1024;               // preview JPEG
const MAX_SIDE = 1152, MIN_SIDE = 64;
const PREVIEW_W = 1200, PREVIEW_H = 630;
const TTL = 180 * 24 * 3600;                  // images: older links fall back to redrawing
const PREVIEW_TTL = 60 * 24 * 3600;           // previews matter while a link is being passed around
const DAY_MAX_UPLOADS = 220;                  // ≤ ~2 KV writes each → well inside 1000 writes/day
const DAY_MAX_BYTES = 4 * 1024 * 1024;        // images: × 180 days ≈ 0.7 GB
const DAY_MAX_PREVIEW_BYTES = 3 * 1024 * 1024; // previews: × 60 days ≈ 0.18 GB
const GALLERY_MAX = 60, GALLERY_HIDE_AT = 3, DAY_MAX_GALLERY = 120;
const ID_RX = /^[A-Za-z0-9_-]{8,32}$/;

const cors = origin => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});
const json = (body, status, origin, extra) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin), ...(extra || {}) } });

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

// A complete JPEG (SOI … EOI) whose frame header says exactly w×h, or null.
function jpegSize(b) {
  if (b.length < 200 || b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = b[i + 2] << 8 | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

async function idFor(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const s = btoa(String.fromCharCode(...h.subarray(0, 12)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// IPv6 users get a whole /64 each, so limit per /64 instead of per address.
function netKey(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}
async function burstOk(env, req) {
  if (!env.RL) return true;
  const { success } = await env.RL.limit({ key: netKey(req.headers.get('CF-Connecting-IP')) });
  return success;
}
// Daily budget, one KV key per kind and day: { n: count, b: bytes }.
async function spend(env, kind, bytes, maxN, maxB) {
  const key = 'day:' + kind + ':' + new Date().toISOString().slice(0, 10);
  const day = (await env.SHOTS.get(key, { type: 'json' })) || { n: 0, b: 0 };
  if (day.n >= maxN || day.b + bytes > maxB) return false;
  await env.SHOTS.put(key, JSON.stringify({ n: day.n + 1, b: day.b + bytes }), { expirationTtl: 2 * 86400 });
  return true;
}
const exists = async (env, key) => !!(await env.SHOTS.get(key, { type: 'stream' }));

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sharePage(origin, id, hasPreview) {
  const img = hasPreview ? origin + '/p/' + id : SITE + '/og.jpg';
  const title = 'ROT — a look made with ROT';
  const desc = 'Open it to see the image and the exact look, live. Remix it, break it, share it back.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="ROT">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="${PREVIEW_W}"><meta property="og:image:height" content="${PREVIEW_H}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#070812">
<style>html,body{margin:0;height:100%;background:#070812;color:#f3f4ff;font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center}a{color:#9b8cff}</style>
<script>location.replace(${JSON.stringify(SITE + '/')}+(location.hash||''))</script></head>
<body><a id="go" href="${SITE}/">Open ROT</a><script>document.getElementById('go').href=${JSON.stringify(SITE + '/')}+(location.hash||'')</script></body></html>`;
}

async function readGallery(env) { return (await env.SHOTS.get('gallery', { type: 'json' })) || []; }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const fromSite = origin && ALLOWED_ORIGINS.includes(origin);

    // ---- reads
    let m;
    if (req.method === 'GET' && (m = path.match(/^\/(i|p)\/([A-Za-z0-9_-]{8,32})$/))) {
      const value = await env.SHOTS.get((m[1] === 'i' ? 'img:' : 'pv:') + m[2], { type: 'arrayBuffer' });
      if (!value) return json({ error: 'not_found' }, 404, origin);
      return new Response(value, {
        headers: {
          'Content-Type': m[1] === 'i' ? 'image/webp' : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          ...cors(origin)
        }
      });
    }
    if (req.method === 'GET' && (m = path.match(/^\/(?:s\/)?([A-Za-z0-9_-]{12,32})$/))) {
      const has = await exists(env, 'pv:' + m[1]);
      return new Response(sharePage(url.origin, m[1], has), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': has ? 'public, max-age=86400' : 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' }
      });
    }
    if (req.method === 'GET' && path === '/g') {
      const list = (await readGallery(env)).filter(e => (e.r || 0) < GALLERY_HIDE_AT).map(({ id, img, p, l, at }) => ({ id, img, p, l, at }));
      return json({ items: list }, 200, origin, { 'Cache-Control': 'public, max-age=20' });
    }

    // ---- writes: only from the site
    if (!['POST', 'PUT'].includes(req.method)) return json({ error: 'not_found' }, 404, origin);
    if (!fromSite) return json({ error: 'origin' }, 403, origin);

    if (req.method === 'POST' && path === '/i') {
      if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const bytes = await readCapped(req, MAX_BYTES);
      if (!bytes) return json({ error: 'too_large' }, 413, origin);
      if (!webpSize(bytes)) return json({ error: 'not_an_image' }, 415, origin);
      const id = await idFor(bytes), key = 'img:' + id;
      if (await exists(env, key)) return json({ id }, 200, origin);
      if (!(await spend(env, 'img', bytes.length, DAY_MAX_UPLOADS, DAY_MAX_BYTES))) return json({ error: 'budget' }, 429, origin);
      await env.SHOTS.put(key, bytes, { expirationTtl: TTL, metadata: { at: Date.now() } });
      return json({ id }, 201, origin);
    }

    if (req.method === 'PUT' && (m = path.match(/^\/p\/([A-Za-z0-9_-]{12,32})$/))) {
      if ((+req.headers.get('Content-Length') || 0) > MAX_PREVIEW) return json({ error: 'too_large' }, 413, origin);
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const bytes = await readCapped(req, MAX_PREVIEW);
      if (!bytes) return json({ error: 'too_large' }, 413, origin);
      const d = jpegSize(bytes);
      if (!d || d.w !== PREVIEW_W || d.h !== PREVIEW_H) return json({ error: 'not_a_preview' }, 415, origin);
      const key = 'pv:' + m[1];
      if (await exists(env, key)) return json({ error: 'taken' }, 409, origin); // write-once
      if (!(await spend(env, 'pv', bytes.length, DAY_MAX_UPLOADS, DAY_MAX_PREVIEW_BYTES))) return json({ error: 'budget' }, 429, origin);
      await env.SHOTS.put(key, bytes, { expirationTtl: PREVIEW_TTL });
      return json({ id: m[1] }, 201, origin);
    }

    if (req.method === 'POST' && (path === '/g' || path === '/g/report')) {
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const body = await readCapped(req, 4096);
      let o = null;
      try { o = JSON.parse(new TextDecoder().decode(body || new Uint8Array(0))); } catch (e) {}
      if (!o || typeof o !== 'object') return json({ error: 'bad_request' }, 400, origin);

      if (path === '/g/report') {
        if (!ID_RX.test(String(o.id || ''))) return json({ error: 'bad_request' }, 400, origin);
        const list = await readGallery(env), e = list.find(x => x.id === o.id);
        if (!e) return json({ ok: true }, 200, origin);
        e.r = (e.r || 0) + 1;
        await env.SHOTS.put('gallery', JSON.stringify(list));
        return json({ ok: true, hidden: e.r >= GALLERY_HIDE_AT }, 200, origin);
      }

      // publish: only images the generator made (they passed the AI Horde safety filter) with a stored preview
      const img = String(o.img || ''), p = String(o.p || ''), l = String(o.l || '');
      if (!ID_RX.test(img) || !ID_RX.test(p) || !/^[A-Za-z0-9_-]{8,3000}$/.test(l)) return json({ error: 'bad_request' }, 400, origin);
      if (!(await exists(env, 'img:' + img)) || !(await exists(env, 'pv:' + p))) return json({ error: 'not_found' }, 404, origin);
      const list = await readGallery(env);
      const dup = list.find(x => x.p === p);
      if (dup) return json({ id: dup.id }, 200, origin);
      if (!(await spend(env, 'gal', 0, DAY_MAX_GALLERY, 1))) return json({ error: 'budget' }, 429, origin);
      const id = p;
      list.unshift({ id, img, p, l, at: Date.now(), r: 0 });
      await env.SHOTS.put('gallery', JSON.stringify(list.slice(0, GALLERY_MAX)));
      return json({ id }, 201, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  }
};
