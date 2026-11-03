/* DAA first-party measurement beacon — measure.js
 *
 * WHAT IT SENDS (and nothing else):
 *   { type: "pageview", page: <URL path>, refHost: <referrer hostname or null>,
 *     ts: <ISO timestamp> }
 *   Optional CTA events via window.DAAMeasure("name"):
 *   { type: "event", name: <string>, page: <URL path>, ts: <ISO timestamp> }
 *
 * WHAT IT NEVER DOES: no cookies, no localStorage, no fingerprinting, no
 * visitor identifier of any kind, no full referrer URL (host only), no IP
 * handling (the endpoint discards network metadata by design), no
 * third-party requests. Honors Do Not Track.
 *
 * DO NOT WIRE THIS INTO ANY PAGE until:
 *   (1) the ingest endpoint is deployed (set MEASURE_ENDPOINT below), and
 *   (2) the privacy policy revision describing this collection has shipped
 *       IN THE SAME DELIVERY. The policy published through 2026-10-23
 *       promises "no analytics… nothing reports your visit back to us" —
 *       wiring this beacon before that sentence is lawfully revised would
 *       make the site contradict its own policy. See O2-measurement.md.
 */
(function () {
  'use strict';

  var MEASURE_ENDPOINT = null; /* e.g. 'https://ingest.<host>/collect' — set at wiring time */

  if (!MEASURE_ENDPOINT) return;
  try { if (navigator.doNotTrack === '1') return; } catch (e) { /* continue */ }

  function refHost() {
    try {
      if (!document.referrer) return null;
      return new URL(document.referrer).hostname || null;
    } catch (e) { return null; }
  }

  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(MEASURE_ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(MEASURE_ENDPOINT, {
          method: 'POST', body: body, keepalive: true,
          headers: { 'Content-Type': 'application/json' }
        }).catch(function () {});
      }
    } catch (e) { /* measurement must never break a page */ }
  }

  function pageview() {
    send({
      type: 'pageview',
      page: location.pathname,
      refHost: refHost(),
      ts: new Date().toISOString()
    });
  }

  window.DAAMeasure = function (name) {
    send({
      type: 'event',
      name: String(name == null ? '' : name).slice(0, 60),
      page: location.pathname,
      ts: new Date().toISOString()
    });
  };

  if (document.readyState === 'complete') pageview();
  else window.addEventListener('load', pageview);
})();
