/* DAA live content renderer — a public feature.
   Loads live.json (announcement bar + hero stats). Fails silent.

   History: this file formerly also carried an "owner layer" — a
   dormant telemetry beacon and a "director's commentary" mode gated
   by the sessionStorage flag 'daa_owner', a relic of the retired
   owner console. That machinery was removed on 2026-10-23 (security
   remediation R6): a client-side flag named like an authorization
   boundary is not one, and nothing on the public estate may present
   itself as an owner gate. What remains is the renderer, which was
   always a public feature over public data. */
(function () {
  'use strict';

  /* Only http(s) links out of the announcement bar — never javascript:/data:. */
  function safeUrl(u) {
    try {
      var parsed = new URL(u, location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (e) {}
    return null;
  }

  /* ---------------- live.json ---------------- */
  function applyLive(data) {
    if (!data || typeof data !== 'object') return;
    var a = data.announcement;
    if (a && a.text && !document.querySelector('.announce-bar')) {
      var bar = document.createElement('div');
      bar.className = 'announce-bar';
      bar.setAttribute('role', 'note');
      bar.appendChild(document.createTextNode(a.text));
      var href = a.link ? safeUrl(a.link) : null;
      if (href) {
        var link = document.createElement('a');
        link.href = href;
        link.textContent = a.linkLabel || 'Learn more';
        bar.appendChild(document.createTextNode(' '));
        bar.appendChild(link);
      }
      var nav = document.querySelector('.nav');
      if (nav && nav.parentNode) nav.parentNode.insertBefore(bar, nav);
      else document.body.insertBefore(bar, document.body.firstChild);
    }
    if (Array.isArray(data.stats)) {
      var stats = document.querySelectorAll('.hero-stats .stat');
      data.stats.forEach(function (s, i) {
        if (!stats[i] || !s) return;
        var num = stats[i].querySelector('.stat-num');
        var label = stats[i].querySelector('.stat-label');
        if (num && s.num != null) num.textContent = s.num;
        if (label && s.label) label.textContent = s.label;
      });
    }
  }

  if (document.body) startLive();
  else document.addEventListener('DOMContentLoaded', startLive);
  function startLive() {
    fetch('live.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(applyLive)
      .catch(function () { /* static defaults stand */ });
  }
})();
