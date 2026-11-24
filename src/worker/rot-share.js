// rot-share — Cloudflare Worker behind ROT's share links and text → image. Deployed at
// https://rot-share.nicoflp.workers.dev with a KV binding SHOTS, a Workers AI binding AI and (optional) a
// rate-limit binding RL; share links use the custom domain https://s.nicoflp.com/<id>#rot=….
//
//   POST /gen          { q } → { img (base64 JPEG), id?, p }: FLUX.1 schnell on Workers AI. The request is
//                      checked by Llama Guard (fail-closed) and a word filter, rewritten into a richer prompt,
//                      drawn, and the picture is stored here so a share link opens the exact same image (id)
//   GET  /i/<id>       a stored generated image, immutable. Only /gen stores images: there is no upload route,
//                      so the store cannot be used to host arbitrary files
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
const MAX_BYTES = 400 * 1024;                 // a generated JPEG
const MAX_PREVIEW = 220 * 1024;               // preview JPEG
const MAX_SIDE = 1152, MIN_SIDE = 64;
const PREVIEW_W = 1200, PREVIEW_H = 630;
const TTL = 90 * 24 * 3600;                   // images: older links fall back to redrawing
const PREVIEW_TTL = 60 * 24 * 3600;           // previews matter while a link is being passed around
const DAY_MAX_UPLOADS = 220;                  // ≤ ~2 KV writes each → well inside 1000 writes/day
const DAY_MAX_BYTES = 8 * 1024 * 1024;        // images: × 90 days ≈ 0.7 GB
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
          'Content-Type': m[1] === 'i' && new Uint8Array(value, 0, 1)[0] !== 0xff ? 'image/webp' : 'image/jpeg',
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
    if (req.method === 'GET' && path === '/g') return json({ items: [], closed: true }, 200, origin, { 'Cache-Control': 'public, max-age=300' });

    // ---- writes: only from the site
    if (!['POST', 'PUT'].includes(req.method)) return json({ error: 'not_found' }, 404, origin);
    if (!fromSite) return json({ error: 'origin' }, 403, origin);

    if (req.method === 'POST' && path === '/i') return json({ error: 'gone' }, 410, origin);
    if (req.method === 'POST' && path === '/gen') {
      if (!env.AI) return json({ error: 'unavailable' }, 503, origin);
      if (!(await burstOk(env, req))) return json({ error: 'rate_limited' }, 429, origin);
      const body = await readCapped(req, 2048);
      let o = null;
      try { o = JSON.parse(new TextDecoder().decode(body || new Uint8Array(0))); } catch (e) {}
      const q = String((o && o.q) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!q) return json({ error: 'bad_request' }, 400, origin);
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
        const r = await env.AI.run(LLM, { messages: [{ role: 'system', content: ENHANCE }, { role: 'user', content: q }], max_tokens: 140, temperature: 0.6 });
        const t = String((r && r.response) || '').replace(/[*_`#>]/g, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
        // a refusal in any wording counts, not only a reply that starts with BLOCKED
        if (/\bBLOCKED\b/i.test(t) || /^(i'?m sorry|sorry|i can(?:no|')t|i cannot|i won'?t|i'?m (?:not able|unable)|as an ai)/i.test(t)) return json({ error: 'censored' }, 422, origin);
        if (t.length >= 12 && t.length <= 700 && !blockedWords(t)) prompt = t;
      } catch (e) { /* the guard passed: draw the words as typed */ }
      let out;
      try { out = await env.AI.run(FLUX, { prompt, steps: 6, seed: Math.floor(Math.random() * 2147483647) }); }
      catch (e) { return json({ error: 'model' }, 502, origin); }
      if (!out || typeof out.image !== 'string' || out.image.length < 200) return json({ error: 'model' }, 502, origin);
      // keep the picture so a share link opens exactly this image (within the daily storage budget)
      let id = null;
      try {
        const bin = Uint8Array.from(atob(out.image), c => c.charCodeAt(0)), dim = jpegSize(bin);
        if (dim && bin.length <= MAX_BYTES && dim.w <= 2048 && dim.h <= 2048) {
          id = await idFor(bin);
          if (!(await exists(env, 'img:' + id))) {
            if (await spend(env, 'img', bin.length, DAY_MAX_UPLOADS, DAY_MAX_BYTES)) await env.SHOTS.put('img:' + id, bin, { expirationTtl: TTL, metadata: { at: Date.now(), gen: 1 } });
            else id = null;
          }
        }
      } catch (e) { id = null; }
      return json({ img: out.image, id, p: prompt }, 200, origin, { 'Cache-Control': 'no-store' });
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
