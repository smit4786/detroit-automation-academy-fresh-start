/* Detroit Automation Academy — platform navigation, single source.
 * v4.0 (2026-10-31): the nav markup is inlined in every page's static HTML
 * (domain fix program T4), so the static/no-JS link graph is complete.
 * This script now ENHANCES the static markup — mobile toggle + active-lane
 * state — and renders from scratch only as a fallback for a page whose
 * mount is empty. data-audience hooks (viewer|reader|user|visitor|
 * subscriber) are stable attributes for future personalization. No auth.
 */
(function () {
  'use strict';

    /* Audience lanes. Order is the nav order. Flat — no dropdown layers.
   * Keep in sync with the static markup inlined in the pages. */
  var LANES = [
    { label: 'Live Map', href: '/live-transit.html', audience: 'user' },
    { label: 'Cities', href: '/live-transit/', audience: 'user' },
    { label: 'Programs', href: '/programs.html', audience: 'visitor' },
    { label: 'The Signal', href: '/signal/', audience: 'reader' },
    { label: 'The Index', href: '/the-index/', audience: 'reader' },
    { label: 'Contact', href: '/inquire.html', audience: 'visitor' },
    { label: 'Find', href: '/find.html', audience: 'visitor' }
  ];

  /* Tree-root base path, derived at load time from this script's own
   * URL (nav.js sits at the tree root, so the base is the directory
   * portion of its URL): '/' on production, '/<subpath>/' when the
   * tree is served under a subpath (e.g. the staging mirror). Captured
   * at load because document.currentScript is only set while this
   * script itself is executing, not when build() runs later. Falls
   * back to '/' — the historical behavior — if no script URL is
   * available. */
  var BASE = (function () {
    var src = '';
    try {
      src = (document.currentScript && document.currentScript.src) || '';
    } catch (e) { src = ''; }
    if (!src) {
      try {
        var scripts = document.getElementsByTagName ?
          document.getElementsByTagName('script') : [];
        for (var si = 0; si < scripts.length; si++) {
          var cand = scripts[si] && scripts[si].src ? String(scripts[si].src) : '';
          if (/\/nav\.js$/.test(cand.split('#')[0].split('?')[0])) { src = cand; break; }
        }
      } catch (e2) { /* keep the '/' fallback */ }
    }
    if (!src) return '/';
    var clean = String(src).split('#')[0].split('?')[0];
    var p = clean;
    var scheme = clean.indexOf('://');
    if (scheme !== -1) {
      var hostSlash = clean.indexOf('/', scheme + 3);
      p = hostSlash === -1 ? '/' : clean.slice(hostSlash);
    }
    var last = p.lastIndexOf('/');
    return last === -1 ? '/' : p.slice(0, last + 1);
  })();

  /* Re-root a root-absolute internal URL under BASE. With BASE '/'
   * the result is byte-identical to the input. External URLs
   * (scheme-absolute or protocol-relative) and non-root hrefs pass
   * through untouched. */
  function resolveHref(href) {
    var h = String(href);
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.indexOf('//') === 0) return h;
    if (h.charAt(0) === '/') return BASE + h.slice(1);
    return h;
  }

  /* Map the current path to its lane for the active state. */
  function activeLane(path) {
    if (/^\/live-transit\.html/.test(path) || /^\/board\//.test(path)) return 'Live Map';
    if (/^\/live-transit\//.test(path)) return 'Cities';
    if (/^\/programs\.html/.test(path) || /^\/curriculum\//.test(path)) return 'Programs';
    if (/^\/signal\//.test(path)) return 'The Signal';
    if (/^\/the-index\//.test(path)) return 'The Index';
    if (/^\/inquire\.html/.test(path)) return 'Contact';
    if (/^\/find\.html/.test(path)) return 'Find';
    return null;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderLane(lane, active) {
    var isActive = active === lane.label;
    var act = isActive ? ' data-active="true" aria-current="page"' : '';
    var ext = lane.external ?
      ' target="_blank" rel="noopener" aria-label="' + esc(lane.label) + ', opens in new tab"' : '';
    var href = lane.external ? lane.href : resolveHref(lane.href);
    return '<a class="lane"' + act + ' data-audience="' + lane.audience +
      '" href="' + esc(href) + '"' + ext + '>' + esc(lane.label) + '</a>';
  }

  function wire(toggle, links) {
    if (!toggle || !links) return;
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function build() {
    var mount = document.getElementById('daa-nav');
    if (!mount) return;

    var path = window.location.pathname || '/';
    /* activeLane's patterns are root-anchored, so under a subpath
     * base the served pathname never matches. Strip the BASE prefix
     * before matching; with BASE '/' this is the identity, so
     * production results are unchanged. */
    var matchPath = path.indexOf(BASE) === 0 ?
      '/' + path.slice(BASE.length) : path;
    var active = activeLane(matchPath);

    /* Static markup present (the normal case since T4): enhance only. */
    if (mount.children.length) {
      var lanes = mount.querySelectorAll('.lane');
      for (var i = 0; i < lanes.length; i++) {
        if (lanes[i].textContent.replace(/\s+/g, ' ').trim() === active) {
          lanes[i].setAttribute('data-active', 'true');
          lanes[i].setAttribute('aria-current', 'page');
        } else {
          lanes[i].removeAttribute('data-active');
          lanes[i].removeAttribute('aria-current');
        }
      }
      wire(document.getElementById('daaNavToggle'),
           document.getElementById('daaNavLinks'));
      return;
    }

    /* Fallback: render the full header, as before T4. */
    var isHome = path === BASE || path === BASE + 'index.html';
    var brandHref = isHome ? '#top' : BASE;
    var lanesHtml = LANES.map(function (l) { return renderLane(l, active); }).join('');

    mount.innerHTML =
      '<header class="nav">' +
      '<a class="brand" href="' + brandHref + '" aria-label="Detroit Automation Academy \u2014 home">' +
      '<img src="' + BASE + 'assets/logo.webp" alt="" class="brand-mark">' +
      '<span class="brand-word">Detroit Automation <em>Academy</em></span></a>' +
      '<nav class="nav-links" id="daaNavLinks" aria-label="Primary">' + lanesHtml + '</nav>' +
      '<button class="nav-toggle" id="daaNavToggle" aria-label="Toggle navigation" aria-expanded="false">' +
      '<span></span><span></span><span></span></button></header>';

    wire(document.getElementById('daaNavToggle'),
         document.getElementById('daaNavLinks'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
