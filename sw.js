/* Live Transit Detroit — offline shell + stale-data fallback (2026-11-06).
 *
 * Hand-rolled, no dependencies. Two caches, both versioned to the page
 * build stamp: each deploy's service worker installs a fresh cache set
 * and activation deletes every older one, so a stale shell can never
 * outlive its build.
 *
 *   - App shell (same-origin assets): cache-first, populated at install
 *     for the core files and at first fetch for the rest.
 *   - Page navigations: network-first — a deploy is never masked by
 *     cache; the cached page is only the offline fallback.
 *   - Live-data JSON: network-first; every good response refreshes the
 *     data cache. When the network fails, the last good payload is
 *     served with an X-LTD-From-Cache: 1 header so the page can label
 *     it with its real last-update time instead of claiming "updated".
 */
'use strict';

var STAMP = '20261106-1619';
var SHELL_CACHE = 'ltd-shell-' + STAMP;
var DATA_CACHE = 'ltd-data-' + STAMP;

var SHELL_URLS = [
  './live-transit.html',
  './live-transit.js?v=' + STAMP,
  './live-fusion.js?v=' + STAMP,
  './styles.css?v=20261019-1228',
  './ride-along.css?v=20261019-1228',
  './nav.js?v=20261023-0221',
  './assets/logo.webp',
  './assets/three.module.min.js?v=20261019-1228'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Each asset added on its own: one missing file must not sink the
      // whole install (the runtime handler below re-caches on fetch).
      return Promise.all(SHELL_URLS.map(function (u) {
        return cache.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== SHELL_CACHE && name !== DATA_CACHE) {
          return caches.delete(name);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isLiveData(url) {
  return url.pathname.indexOf('/live-data/') !== -1 &&
    url.pathname.slice(-5) === '.json';
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Live data: network-first, cache fallback marked X-LTD-From-Cache.
  if (isLiveData(url)) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(DATA_CACHE).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return res;
      }).catch(function () {
        return caches.open(DATA_CACHE).then(function (cache) {
          return cache.match(req).then(function (hit) {
            if (!hit) throw new Error('no cached payload');
            return hit.blob().then(function (body) {
              var headers = new Headers(hit.headers);
              headers.delete('Content-Encoding');
              headers.delete('Content-Length');
              headers.set('X-LTD-From-Cache', '1');
              return new Response(body, {
                status: hit.status,
                statusText: hit.statusText,
                headers: headers
              });
            });
          });
        });
      })
    );
    return;
  }

  // Navigations: network-first; cached page only when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('./live-transit.html');
      })
    );
    return;
  }

  // Same-origin assets: cache-first (URLs carry their build stamps, so
  // a new deploy's URLs miss the old cache and go to the network),
  // populating the shell cache on each first successful fetch.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (cache) {
              cache.put(req, copy);
            });
          }
          return res;
        });
      })
    );
  }
  // Everything else (cross-origin) passes through untouched.
});
