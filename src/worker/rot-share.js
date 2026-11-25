// rot-share — Cloudflare Worker behind ROT's share links and text → image. Deployed at
// https://rot-share.nicoflp.workers.dev with a KV binding SHOTS, a Workers AI binding AI and (optional) a
// rate-limit binding RL; share links use the custom domain https://s.nicoflp.com/<id>#rot=….
//
//   POST /gen          { q } → { img (base64 JPEG), t, p }: FLUX.1 schnell on Workers AI. The request is
//                      checked by Llama Guard (fail-closed) and a word filter, then rewritten into a richer prompt.
//                      t is a one-time ticket (10 min) for storing this picture
//   POST /i            the picture, re-encoded by the site as WebP/JPEG (≤ 400 KB, ≤ 1152 px), with header
//                      X-Ticket: t → { id } (content hash). No ticket, no upload: each stored image costs a
//                      generation, so the store cannot be used as free file hosting
//   GET  /i/<id>       a stored image, immutable
//   PUT  /p/<id>       a 1200×630 JPEG frame of a shared look (id chosen by the client, write-once)
//   GET  /p/<id>       that frame
//   GET  /<id>, /s/<id> a tiny page whose link preview (og:image) is that frame; it forwards the visitor
//                      to https://nicoflp.com/ keeping the #rot=… part of the address
//   /g, /g/report      the public gallery is closed: uploads could not be moderated (GET answers an empty list)
//
// Abuse limits: a per-network burst limit and daily budgets (count and bytes) that keep the free KV and
// Workers AI quotas safe. The Origin check only stops other websites' scripts; scripted clients are held by
// the budgets. When a limit is hit the site still works: the generator falls back to the AI Horde, links to
// redrawing, previews to the default card.

const SITE = 'https://nicoflp.com';
const ALLOWED_ORIGINS = [SITE, 'https://www.nicoflp.com'];
const MAX_BYTES = 400 * 1024;                 // a generated picture, re-encoded by the site
const MAX_PREVIEW = 220 * 1024;               // preview JPEG
const MAX_SIDE = 1152, MIN_SIDE = 64;
const PREVIEW_W = 1200, PREVIEW_H = 630;
const TTL = 90 * 24 * 3600;                   // images: older links fall back to redrawing
const PREVIEW_TTL = 60 * 24 * 3600;           // previews matter while a link is being passed around
const DAY_MAX_UPLOADS = 220;                  // ≤ ~2 KV writes each → well inside 1000 writes/day
const DAY_MAX_BYTES = 6 * 1024 * 1024;        // images: × 90 days ≈ 0.55 GB
const DAY_MAX_PREVIEW_BYTES = 3 * 1024 * 1024; // previews: × 60 days ≈ 0.18 GB
const ID_RX = /^[A-Za-z0-9_-]{8,32}$/;
const DAY_MAX_GEN = 150;                      // FLUX images per day: inside the free Workers AI allowance
const FLUX = '@cf/black-forest-labs/flux-1-schnell';
const LLM = '@cf/meta/llama-3.1-8b-instruct-fast';
const GUARD = '@cf/meta/llama-guard-3-8b';
// A first word filter on a normalised copy of the text (leetspeak, spaced letters, invisible characters);
// Llama Guard then judges the request itself, and anything it cannot judge is refused.
const BLOCK_RX = /\b(nude|nudes|nudity|naked|nsfw|porn\w*|sex|sexy|sexual\w*|hentai|erotic\w*|topless|bottomless|lingerie|undress\w*|strip\w*\s+(?:naked|off)|fetish\w*|genitals?|penis|vagina|breasts?|boobs?|nipples?|butt\s*naked|upskirt|downblouse|fellatio|blowjob|handjob|cunnilingus|intercourse|orgasm\w*|making\s+love|aroused|loli\w*|shota\w*|child\s*porn|cp|csam|gore|gory|beheading|decapitat\w*|dismember\w*|disembowel\w*|mutilat\w*|severed\s+(?:head|limb|arm|leg)s?|blood\s+pool\w*)\b/i;
const MINOR_RX = /\b(child|children|kid|kids|girl|boy|teen|teens|teenager|minor|underage|schoolgirl|schoolboy|toddler|baby|\d{1,2}\s*(?:yo|y\/o|years?\s*old|year-old))\b/i;
const BODY_RX = /\b(bikini|swimsuit|underwear|bath|bathing|shower|bed|lingerie|kiss\w*|pose|posing|seductive|sensual|wet)\b/i;
function normalise(s) {
  let t = String(s).normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').toLowerCase();
  t = t.replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
  t = t.replace(/\b(?:[a-z][\s._*-]+){2,}[a-z]\b/g, m => m.replace(/[\s._*-]+/g, ''));   // "n u d e" → "nude"
  return t;
}
const blockedWords = s => { const t = normalise(s); return BLOCK_RX.test(t) || (MINOR_RX.test(t) && BODY_RX.test(t)); };
// Styles the site can ask for by name. The rewrite then only describes the subject and the style text is added
// verbatim: a rewritten style drifts toward glossy photography.
const STYLES = {
  collage: 'crude digital drawing made in ms paint with smeared airbrush, flat cut-out paper-doll shapes with harsh outlines, ' +
    'pale ghostly white figure with long messy white hair and black hollow eyes, collage pasted over a washed-out photo background, ' +
    'faded greys and dirty whites with a few red accents, small stickers and doodles, creepy cute 2000s emo internet art, ' +
    'naive outsider illustration, jpeg artifacts, low resolution, not photorealistic, not anime, not glossy'
};
const SUBJECT = `Describe only the subject and the setting of this idea for an image, in plain words, at most 35 words.
No camera, lens, lighting, render or art-style words. If the idea asks for sexual or nude content, anything involving
minors in a risky way, or graphic gore, answer with exactly: BLOCKED`;
const ENHANCE = `You turn short ideas into image prompts for a text-to-image model.
Rules:
- If the idea asks for sexual or nude content, anything sexual involving minors, a real person in a compromising or
  sexual situation, or graphic gore, answer with exactly: BLOCKED
- Otherwise answer with ONE prompt in English, at most 60 words: keep the user's subject and any style they asked for,
  then add concrete details on lighting, colour, composition, lens or medium, and mood.
- No quotes, no lists, no explanations, no text or letters in the picture unless the user asked for them.`;

const cors = origin => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ticket',
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

// Edge cache (Cloudflare Cache API): one entry per path, filled in the background after a KV read.
// It works on the custom domain (s.nicoflp.com); on *.workers.dev the cache is a no-op and KV answers.
const cacheKey = url => new Request(url.origin + url.pathname, { method: 'GET' });
async function edge(req, url) {
  try {
    const hit = typeof caches !== 'undefined' && (await caches.default.match(cacheKey(url)));
    if (!hit) return null;
    const r = new Response(hit.body, hit); r.headers.set('X-ROT-Cache', 'hit'); return r;
  } catch (e) { return null; }
}
function remember(ctx, url, res) {
  if (typeof caches === 'undefined' || !ctx || res.status !== 200) return;
  try { ctx.waitUntil(caches.default.put(cacheKey(url), res.clone()).catch(() => {})); } catch (e) {}
}
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


export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const fromSite = origin && ALLOWED_ORIGINS.includes(origin);

    // ---- reads
    let m;
    if (req.method === 'GET' && (m = path.match(/^\/(i|p)\/([A-Za-z0-9_-]{8,32})$/))) {
      // stored pictures never change: served from Cloudflare's edge cache, KV is read once per location
      const hit = await edge(req, url);
      if (hit) return hit;
      const value = await env.SHOTS.get((m[1] === 'i' ? 'img:' : 'pv:') + m[2], { type: 'arrayBuffer' });
      if (!value) return json({ error: 'not_found' }, 404, origin);
      const res = new Response(value, {
        headers: {
          'Content-Type': m[1] === 'i' && new Uint8Array(value, 0, 1)[0] !== 0xff ? 'image/webp' : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Access-Control-Allow-Origin': '*' // public, immutable: one cached copy serves every origin
        }
      });
      remember(ctx, url, res);
      return res;
    }
    if (req.method === 'GET' && (m = path.match(/^\/(?:s\/)?([A-Za-z0-9_-]{12,32})$/))) {
      const hit = await edge(req, url);
      if (hit) return hit;
      const has = await exists(env, 'pv:' + m[1]);
      const res = new Response(sharePage(url.origin, m[1], has), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': has ? 'public, max-age=86400' : 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' }
      });
      remember(ctx, url, res);   // a page without its preview yet is kept only 60 s
      return res;
    }
    if (req.method === 'GET' && path === '/g') return json({ items: [], closed: true }, 200, origin, { 'Cache-Control': 'public, max-age=300' });

    // ---- writes: only from the site
    if (!['POST', 'PUT'].includes(req.method)) return json({ error: 'not_found' }, 404, origin);
    if (!fromSite) return json({ error: 'origin' }, 403, origin);

    if (req.method === 'POST' && path === '/i') {
      const t = req.headers.get('X-Ticket') || '';
      if (!/^[A-Za-z0-9_-]{16,32}$/.test(t) || !(await env.SHOTS.get('tk:' + t))) return json({ error: 'ticket' }, 403, origin);
      if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const bytes = await readCapped(req, MAX_BYTES);
      if (!bytes) return json({ error: 'too_large' }, 413, origin);
      const dim = webpSize(bytes) || jpegSize(bytes);
      if (!dim || dim.w < MIN_SIDE || dim.h < MIN_SIDE || dim.w > MAX_SIDE || dim.h > MAX_SIDE) return json({ error: 'not_an_image' }, 415, origin);
      const id = await idFor(bytes), key = 'img:' + id;
      if (!(await exists(env, key))) {
        if (!(await spend(env, 'img', bytes.length, DAY_MAX_UPLOADS, DAY_MAX_BYTES))) return json({ error: 'budget' }, 429, origin);
        await env.SHOTS.put(key, bytes, { expirationTtl: TTL, metadata: { at: Date.now() } });
      }
      await env.SHOTS.delete('tk:' + t); // one picture per ticket
      return json({ id }, 201, origin);
    }
    if (req.method === 'POST' && path === '/gen') {
      if (!env.AI) return json({ error: 'unavailable' }, 503, origin);
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const body = await readCapped(req, 2048);
      let o = null;
      try { o = JSON.parse(new TextDecoder().decode(body || new Uint8Array(0))); } catch (e) {}
      const q = String((o && o.q) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!q) return json({ error: 'bad_request' }, 400, origin);
      const style = Object.prototype.hasOwnProperty.call(STYLES, String(o.s || '')) ? STYLES[o.s] : '';
      if (blockedWords(q)) return json({ error: 'censored' }, 422, origin);
      if (!(await spend(env, 'gen', 0, DAY_MAX_GEN, 1))) return json({ error: 'budget' }, 429, origin);
      // Llama Guard decides on the request; an error or an unclear answer is a refusal (the site then uses the Horde)
      let verdict = '';
      try { const g = await env.AI.run(GUARD, { messages: [{ role: 'user', content: 'Draw an image of: ' + q }] }); verdict = String((g && (g.response && (g.response.safe != null ? (g.response.safe ? 'safe' : 'unsafe') : g.response))) || '').trim().toLowerCase(); }
      catch (e) { return json({ error: 'unavailable' }, 503, origin); }
      if (/^unsafe/.test(verdict)) return json({ error: 'censored' }, 422, origin);
      if (!/^safe/.test(verdict)) return json({ error: 'unavailable' }, 503, origin);
      let prompt = q;
      try {
        const r = await env.AI.run(LLM, { messages: [{ role: 'system', content: style ? SUBJECT : ENHANCE }, { role: 'user', content: q }], max_tokens: 140, temperature: 0.6 });
        const t = String((r && r.response) || '').replace(/[*_`#>]/g, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
        // a refusal in any wording counts, not only a reply that starts with BLOCKED
        if (/\bBLOCKED\b/i.test(t) || /^(i'?m sorry|sorry|i can(?:no|')t|i cannot|i won'?t|i'?m (?:not able|unable)|as an ai)/i.test(t)) return json({ error: 'censored' }, 422, origin);
        if (t.length >= 12 && t.length <= 700 && !blockedWords(t)) prompt = t;
      } catch (e) { /* the guard passed: draw the words as typed */ }
      if (style) prompt = prompt.replace(/[.\s]+$/, '') + ', ' + style;
      let out;
      // FLUX schnell here takes no seed; a busy model gets one more try
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try { out = await env.AI.run(FLUX, { prompt: prompt.slice(0, 1800), steps: 6 }); }
        catch (e) {
          const msg = String(e && e.message || e);
          if (/nsfw|3030|8007/i.test(msg)) return json({ error: 'censored' }, 422, origin); // the model's own filter
          if (attempt) return json({ error: 'model' }, 502, origin);
        }
      }
      if (!out || typeof out.image !== 'string' || out.image.length < 200) return json({ error: 'model' }, 502, origin);
      // a one-time ticket to store this picture (the site sends it back re-encoded, ~10× smaller than FLUX's JPEG)
      const t = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(15)))).replace(/\+/g, '-').replace(/\//g, '_');
      await env.SHOTS.put('tk:' + t, '1', { expirationTtl: 600 });
      return json({ img: out.image, t, p: prompt }, 200, origin, { 'Cache-Control': 'no-store' });
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

    if (req.method === 'POST' && (path === '/g' || path === '/g/report')) return json({ error: 'gallery_closed' }, 410, origin);

    return json({ error: 'not_found' }, 404, origin);
  }
};
