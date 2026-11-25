// ROT service worker: lets the installed app start offline.
// Pages are network-first (a new deploy shows up as soon as you are online);
// static files are served from cache and refreshed in the background.
const CACHE = 'rot-v2';
const CORE = [
  './',
  'index.html',
  'vendor/three.min.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'live/live.css?v=1',
  'live/core.js?v=1',
  'live/autopilot.js?v=1',
  'live/mutate.js?v=1',
  'live/scenes.js?v=1',
  'live/seq.js?v=1',
  'live/midi.js?v=1',
  'live/clip.js?v=1',
  'live/quick.js?v=1',
  'live/ui.js?v=1',
  'live/presets.js?v=1',
  'live/modes.js?v=1',
  'live/motion.js?v=1'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('rot-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !CACHEABLE_HOSTS.includes(url.hostname)) return;

  // Pages: network first, cached copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); }
          return res;
        })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else: cache first, refresh in the background.
  e.respondWith(
    caches.open(CACHE).then(c => c.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    }))
  );
});
