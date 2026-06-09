/**
 * Service worker: offline app shell.
 *
 * Strategy (deliberately NOT the default cache-first PWA setup):
 *  - Navigations (index.html) are NETWORK-FIRST. An online refresh always
 *    fetches the page from GitHub Pages, so a new deploy shows up on the very
 *    next reload — the SW never serves a stale shell while online. Only when
 *    the network fails (offline / 3s timeout) does the cached copy serve.
 *  - Hashed build assets (assets/*-<hash>.js etc.) are precached at install
 *    from the build manifest. They're content-addressed and immutable, so
 *    cache-first is always correct, and precaching the FULL manifest means
 *    lazy chunks (automerge worker, inline fallback) work offline even if a
 *    session never loaded them online.
 *  - index.html is intentionally EXCLUDED from the precache manifest (see
 *    injectManifest.globPatterns in vite.config.js) — if it were precached,
 *    Workbox would serve it cache-first and break the refresh-gets-new-code
 *    guarantee above.
 *  - Google Fonts get the standard recipe: stylesheet stale-while-revalidate,
 *    font binaries cache-first for a year.
 *
 * gapi (apis.google.com) is deliberately not cached: App.jsx already treats
 * its load failure as "offline" and lifts the surface gates.
 */
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()

precacheAndRoute(self.__WB_MANIFEST)

const PAGES_CACHE = 'pages'
const BASE = self.registration.scope // e.g. https://theitush.github.io/yajna/

// Warm the shell at install so offline works from the very first visit —
// the navigation that installed this SW wasn't intercepted by it, so without
// this the pages cache would stay empty until a second online load.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGES_CACHE).then((cache) => cache.add(BASE)).catch(() => {})
  )
})

registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: PAGES_CACHE,
    networkTimeoutSeconds: 3,
    // The OAuth redirect lands with query params; match the cached shell
    // regardless so an offline open never misses on a stray ?query.
    matchOptions: { ignoreSearch: true },
    plugins: [new ExpirationPlugin({ maxEntries: 8 })],
  })
)

registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'google-fonts-stylesheets' })
)

registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  })
)
