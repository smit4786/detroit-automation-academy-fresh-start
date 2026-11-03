// Detroit Automation Academy — site interactions
(function () {
  'use strict';

  // Mobile nav toggle
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
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

  // Reveal-on-scroll
  // The stylesheet also defines a scroll-driven animation under
  // @supports (animation-timeline: view()). That path is progressive
  // enhancement only: the observer below is the mechanism of record, because
  // feature-detecting the shorthand property ('animationTimeline' in style)
  // is NOT the same test as @supports (animation-timeline: view()), and on a
  // partial implementation the old skip-the-observer branch left every
  // .reveal element at opacity 0 forever -- a blank page. Double-triggering
  // is harmless: adding .visible twice changes nothing visually.
  var revealEls = document.querySelectorAll('.section .wrap, .hero-inner, .hero-stats, .card, .phase, .principle');
  revealEls.forEach(function (el) { el.classList.add('reveal'); });

  function revealEl(el) { el.classList.add('visible'); }

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          revealEl(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { observer.observe(el); });
  } else {
    revealEls.forEach(revealEl);
  }

  // Safety net: the landing page must never render blank. If anything above
  // the fold is still invisible shortly after load (stalled observer, partial
  // CSS animation support), reveal it.
  function revealAboveFold() {
    var vh = window.innerHeight || 0;
    revealEls.forEach(function (el) {
      if (el.classList.contains('visible')) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < vh && rect.bottom > 0) revealEl(el);
    });
  }
  if (document.readyState === 'complete') {
    setTimeout(revealAboveFold, 2000);
  } else {
    window.addEventListener('load', function () { setTimeout(revealAboveFold, 2000); });
  }
})();

  // One-command demo: terminal drives the training bot
  (function () {
    var bot = document.getElementById('demoBot');
    var form = document.getElementById('demoForm');
    var input = document.getElementById('demoInput');
    var log = document.getElementById('demoLog');
    if (!bot || !form || !input || !log) return;

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var ANIM_CLASSES = ['anim-forward', 'anim-back', 'anim-spin', 'anim-scan', 'anim-wave',
      'anim-dance', 'anim-jump', 'anim-charge', 'anim-turn-left', 'anim-turn-right'];
    var COMMANDS = {
      forward: { anim: 'anim-forward', reply: 'Rolling forward one meter. No excuses.' },
      back:    { anim: 'anim-back',    reply: "Backing up. Even robots check their blind spots." },
      left:    { anim: 'anim-turn-left',  reply: 'Pivoting left. Forty-five degrees of intent.' },
      right:   { anim: 'anim-turn-right', reply: 'Pivoting right. Forty-five degrees of intent.' },
      spin:    { anim: 'anim-spin',    reply: "Full 360\u00B0. That's one rotation of confidence." },
      scan:    { anim: 'anim-scan',    reply: 'Scan complete \u2014 path is clear. Build on, Detroit.' },
      wave:    { anim: 'anim-wave',    reply: 'Hello, Detroit. Good to meet a builder.' },
      dance:   { anim: 'anim-dance',   reply: 'Servo shuffle. The workshop playlist is all Motown.' },
      jump:    { anim: 'anim-jump',    reply: 'Twelve centimeters of pure ambition.' },
      charge:  { anim: 'anim-charge',  reply: 'Topping up. A builder never runs on empty.',
                 fn: function () { battery = 100; } },
      focus:   { anim: null,         reply: 'Camera on the bot. There it is.' },
      patrol:  { anim: null,         reply: 'Fleet on patrol. The bee is doing its rounds.' },
      follow:  { anim: null,         reply: 'Fleet falling in. Escort formation.' },
      rtp:     { anim: null,         reply: 'Fleet returning to pads.' }
    };

    /* ---- Training district (world v1): five Detroit stops to explore.
          Moving costs battery; "charge" refills it. ---- */
    var WORLD = {
      workshop:   { name: 'The Workshop',
        desc: 'Home base. Workbenches, spare servos, the smell of solder. Every builder starts here.',
        exits: { north: 'innovation', east: 'hq', south: 'riverfront', west: 'thinkabit' } },
      innovation:   { name: 'UM Center for Innovation',
        desc: 'U-M\u2019s Detroit innovation hub \u2014 six stories of glass leaning into the future. The portal is open to everyone.',
        exits: { south: 'workshop' } },
      hq:         { name: 'Academy HQ',
        desc: 'The new Detroit Automation Academy headquarters in Corktown — glass, brick, and big plans.',
        exits: { west: 'workshop' } },
      riverfront: { name: 'Detroit Riverfront',
        desc: "Wind off the water, skyline at your back. The view never gets old.",
        exits: { north: 'workshop' } },
      thinkabit:  { name: 'Thinkabit Lab',
        desc: 'A STEM lab buzzing with kits and big questions. Young engineers at work.',
        exits: { east: 'workshop' } }
    };
    var DIRS = ['north', 'east', 'south', 'west'];
    var MOVE_COST = 5;
    var botLoc = 'workshop';
    var battery = 100;

    function clearAnims() {
      ANIM_CLASSES.forEach(function (c) { bot.classList.remove(c); });
    }

    /* 3D bridge: when the Three.js district is live, commands drive the 3D
       bot instead of the SVG one. Null until world3d.js finishes loading. */
    function world3d() {
      var live = document.getElementById('demoStage').classList.contains('world-live');
      return (live && window.DAAWorld) ? window.DAAWorld : null;
    }

    function printLine(kind, text) {
      var line = document.createElement('div');
      line.className = 'demo-line ' + kind;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
      if (reduced || kind === 'demo-line-in') {
        line.textContent = text;
        return;
      }
      // Typewriter output for full-motion users
      var i = 0;
      var timer = setInterval(function () {
        i += 1;
        line.textContent = text.slice(0, i);
        log.scrollTop = log.scrollHeight;
        if (i >= text.length) clearInterval(timer);
      }, 14);
    }

    function exitsList() {
      return DIRS.filter(function (d) { return WORLD[botLoc].exits[d]; });
    }

    function look() {
      var w = WORLD[botLoc];
      var w3 = world3d();
      if (w3) w3.look(botLoc);
      printLine('demo-line-out', w.name + ' \u2014 ' + w.desc);
      printLine('demo-line-out', 'Exits: ' + exitsList().join(' \u00B7 '));
    }

    function showMap() {
      function cell(key, label) {
        var s = ' ' + label + ' ';
        return key === botLoc ? '[' + s + '*]' : '[' + s + ']';
      }
      printLine('demo-line-out', '              ' + cell('innovation', 'Innov'));
      printLine('demo-line-out', '                  |');
      printLine('demo-line-out',
        cell('thinkabit', 'Thinkabit') + '---' + cell('workshop', 'Workshop') + '---' + cell('hq', 'HQ'));
      printLine('demo-line-out', '                  |');
      printLine('demo-line-out', '              ' + cell('riverfront', 'Riverfront'));
      printLine('demo-line-out', '* marks where you are. Battery ' + Math.round(battery) + '%.');
    }

    function status() {
      var w3 = world3d();
      var extra = '';
      if (w3 && typeof w3.telemetry === 'function') {
        var t = w3.telemetry();
        extra = t.airborne ? ' Airborne at ' + t.alt.toFixed(1) + ' m.' : ' On the ground.';
      }
      printLine('demo-line-out',
        'Battery ' + Math.round(battery) + '%. Location: ' + WORLD[botLoc].name + '.' + extra + ' Morale: Detroit.');
    }

    function travel(dest) {
      var here = WORLD[botLoc];
      var target = here.exits[dest] || null;
      if (!target && dest) {
        /* allow naming a place directly ("go innovation", "go hq") */
        var key = Object.keys(WORLD).filter(function (k) {
          return k === dest || WORLD[k].name.toLowerCase() === dest;
        })[0];
        if (key && exitsList().some(function (d) { return here.exits[d] === key; })) target = key;
      }
      if (!target) {
        printLine('demo-line-out', "Can't go that way from here. Try: " + exitsList().join(', ') + '.');
        return;
      }
      if (battery < MOVE_COST) {
        printLine('demo-line-out', 'Battery too low to travel. Type "charge".');
        return;
      }
      battery -= MOVE_COST;
      botLoc = target;
      var w3 = world3d();
      printLine('demo-line-ok', (w3 ? 'Lifting off to ' : 'Rolling to ') + WORLD[target].name + '.');
      if (w3) {
        w3.goTo(target, look); // describe the stop when the bot arrives
      } else {
        clearAnims();
        void bot.getBoundingClientRect(); // restart the animation
        if (!reduced) bot.classList.add('anim-forward');
        look();
      }
    }

    /* Flight commands. The training bot is a quadcopter in the 3D district:
       takeoff / land / up / down fly it; forward/back/left/right move it
       horizontally when airborne and taxi it when it is on its skids. */
    function need3d() {
      var w3 = world3d();
      if (!w3) printLine('demo-line-out', 'The 3D district is still loading — the drone needs it.');
      return w3;
    }
    function takeoffDrone() {
      var w3 = need3d(); if (!w3) return;
      if (reduced) { printLine('demo-line-out', 'Reduced motion is on — the drone stays grounded.'); return; }
      if (w3.isAirborne()) { printLine('demo-line-out', 'Already airborne.'); return; }
      if (battery < 15) { printLine('demo-line-out', 'Battery too low to take off. Type "charge".'); return; }
      w3.takeoff();
      printLine('demo-line-ok', 'Motors armed. Lifting off.');
    }
    function landDrone() {
      var w3 = need3d(); if (!w3) return;
      if (!w3.isAirborne()) { printLine('demo-line-out', 'Already on the ground.'); return; }
      w3.land();
      printLine('demo-line-ok', 'Landing.');
    }
    function altitudeNudge(cmd) {
      var w3 = need3d(); if (!w3) return;
      if (reduced) { printLine('demo-line-out', 'Reduced motion is on — the drone stays grounded.'); return; }
      var dir = (cmd === 'up') ? 1 : -1;
      if (dir < 0 && !w3.isAirborne()) { printLine('demo-line-out', 'Already on the ground.'); return; }
      if (dir > 0 && !w3.isAirborne() && battery < 15) {
        printLine('demo-line-out', 'Battery too low to take off. Type "charge".'); return;
      }
      w3.altitude(dir);
      printLine('demo-line-ok', dir > 0 ? 'Climbing.' : 'Descending.');
    }

    function printHelp() {
      printLine('demo-line-out', 'Moves: forward · back · left · right · spin · wave · dance · jump');
      printLine('demo-line-out', 'Fly: takeoff · land · up · down (the bot is a quadcopter now)');
      printLine('demo-line-out', 'Explore: look · focus · go <north|east|south|west|place> · map · status');
      printLine('demo-line-out', 'Upkeep: scan · charge');
      printLine('demo-line-out', 'Fleet: patrol · follow · rtp (autonomous bee + scout drones)');
    }

    function run(raw) {
      var cmd = (raw || '').trim().toLowerCase();
      if (!cmd) return;
      printLine('demo-line-in', cmd);
      if (cmd === 'help') { printHelp(); return; }
      if (cmd === 'look') { look(); return; }
      if (cmd === 'map') { showMap(); return; }
      if (cmd === 'status') { status(); return; }
      if (cmd === 'takeoff') { takeoffDrone(); return; }
      if (cmd === 'land') { landDrone(); return; }
      if (cmd === 'up' || cmd === 'down') { altitudeNudge(cmd); return; }
      var parts = cmd.split(/\s+/);
      if (parts[0] === 'go') { travel(parts.slice(1).join(' ')); return; }
      if (parts.length === 1 && DIRS.indexOf(parts[0]) !== -1) { travel(parts[0]); return; }
      var def = COMMANDS[cmd];
      if (!def) {
        printLine('demo-line-out', 'Unknown command \u2014 try "help".');
        return;
      }
      var w3 = world3d();
      if (w3) {
        var act = { forward: function () { w3.nudge(1); }, back: function () { w3.nudge(-1); },
          left: function () { w3.turn(-1); }, right: function () { w3.turn(1); },
          spin: w3.spin, dance: w3.dance, jump: w3.jump, wave: w3.wave,
          scan: w3.scan, charge: w3.charge, focus: w3.focus,
          patrol: w3.patrol, follow: w3.follow, rtp: w3.rtp }[cmd];
        if (act) act();
      } else {
        clearAnims();
        void bot.getBoundingClientRect(); // restart the animation
        if (!reduced) bot.classList.add(def.anim);
      }
      if (def.fn) def.fn();
      printLine('demo-line-ok', def.reply);
    }

    // On touch devices, focusing the text input summons the software keyboard,
    // which covers the 3D scene (reported on iPadOS). Command chips must not
    // trigger it; the user can still tap the input deliberately to type.
    var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      run(input.value);
      input.value = '';
      input.focus();
    });

    document.querySelectorAll('.demo-chip:not(.dpad-btn)').forEach(function (chip) {
      chip.addEventListener('click', function () {
        run(chip.getAttribute('data-cmd'));
        if (!coarsePointer) input.focus();
      });
    });

    /* D-pad: multi-directional drive. Tap for one step, hold to keep rolling.
       Screen-relative like WASD; never summons the keyboard or the page scroll. */
    document.querySelectorAll('.dpad-btn').forEach(function (btn) {
      var parts = (btn.getAttribute('data-drive') || '0,0').split(',');
      var mx = parseFloat(parts[0]) || 0, mz = parseFloat(parts[1]) || 0;
      var timer = null;
      function step() {
        var w3 = world3d();
        if (w3) {
          w3.drive(mx, mz);
        } else {
          clearAnims();
          void bot.getBoundingClientRect(); // restart the animation
          if (!reduced) {
            bot.classList.add(mx ? (mx < 0 ? 'anim-turn-left' : 'anim-turn-right')
                                 : (mz < 0 ? 'anim-forward' : 'anim-back'));
          }
        }
      }
      function stop() {
        if (timer) { clearInterval(timer); timer = null; }
      }
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault(); // no focus change, no double-tap zoom, no scroll
        step();
        stop();
        timer = setInterval(step, 220);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
        btn.addEventListener(ev, stop);
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });

    /* Battery drains with throttle load while the drone flies; a low battery
       forces a landing. The SVG fallback has no motors, so nothing drains. */
    setInterval(function () {
      var w3 = world3d();
      if (!w3 || typeof w3.powerDraw !== 'function') return;
      var draw = w3.powerDraw();
      if (draw > 0.02 && battery > 0) {
        battery = Math.max(0, battery - draw * 0.8);
        if (battery <= 8 && w3.isAirborne()) {
          w3.land();
          printLine('demo-line-out', 'Battery low — landing now. Type "charge" after touchdown.');
        }
      }
    }, 1000);

    bot.addEventListener('animationend', function (e) {
      var c = e.target.classList;
      if (c && (c.contains('bot-body') || c.contains('bot-arm-wave') || c.contains('bot-light'))) {
        clearAnims();
      }
    });

    printLine('demo-line-out', 'Training bot online. Type "help" \u2014 or "look" to start exploring.');
  })();

  // Full-screen view for the 3D demo: native fullscreen on fine-pointer
  // desktops, a fixed overlay on touch devices. Native element fullscreen is
  // flaky or absent on touch OSes — iOS Safari exposes no API at all, and on
  // iPadOS a downward orbit drag or the keyboard appearing dismisses it
  // mid-session — so any touch-capable device gets the overlay instead:
  // nothing dismisses it except the toggle button or Escape, so driving the
  // bot never kicks the user out of the full view.
  (function () {
    var btn = document.getElementById('demoFullscreen');
    var demo = document.getElementById('demoFull');
    if (!btn || !demo) return;
    var enterFs = demo.requestFullscreen || demo.webkitRequestFullscreen;
    var exitFs = document.exitFullscreen || document.webkitExitFullscreen;
    var nativeOK = !!(enterFs && exitFs) &&
      (document.fullscreenEnabled || document.webkitFullscreenEnabled);
    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var touchCapable = (navigator.maxTouchPoints > 0) || ('ontouchstart' in window);
    var mode = (!coarse && !touchCapable && nativeOK) ? 'native' : 'pseudo';

    function isOn() {
      if (mode === 'native') {
        return document.fullscreenElement === demo || document.webkitFullscreenElement === demo;
      }
      return demo.classList.contains('demo-pseudo');
    }
    function label() {
      var on = isOn();
      btn.innerHTML = on ? '&#97979744; Exit full screen' : '&#97979744; Full screen';
      btn.setAttribute('aria-label', on ? 'Exit full screen view' : 'View the 3D district full screen');
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    // world3d resizes off the window resize event; nudge it on toggle.
    function nudge() {
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
    }
    function set(on) {
      if (mode === 'native') {
        try {
          if (on && !isOn()) {
            var p = enterFs.call(demo);
            if (p && p.then) p.then(nudge, nudge); else nudge();
          } else if (!on && isOn()) {
            exitFs.call(document);
          }
        } catch (e) { /* stay inline */ }
      } else {
        demo.classList.toggle('demo-pseudo', on);
        document.body.classList.toggle('demo-locked', on);
        label();
        nudge();
      }
    }
    btn.addEventListener('click', function () { set(!isOn()); });
    document.addEventListener('fullscreenchange', function () { label(); nudge(); });
    document.addEventListener('webkitfullscreenchange', function () { label(); nudge(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mode === 'pseudo' && isOn()) set(false);
    });
    // Terminal collapse toggle (fullscreen only): the log rolls up so the 3D
    // environment stays visible, while input + chips keep the bot drivable.
    // Fullscreen opens compact; closing restores the expanded inline layout.
    var termToggle = document.getElementById('demoTermToggle');
    var term = demo.querySelector('.demo-term');
    function setTermCollapsed(collapsed) {
      if (!term || !termToggle) return;
      term.classList.toggle('demo-term-collapsed', collapsed);
      termToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      termToggle.innerHTML = (collapsed ? '&#70707066;' : '&#71717122;') + ' Terminal';
    }
    if (termToggle && term) {
      termToggle.addEventListener('click', function () {
        setTermCollapsed(!term.classList.contains('demo-term-collapsed'));
        nudge();
      });
      var _set = set;
      set = function (on) { setTermCollapsed(on); _set(on); };
    }
    label();
  })();
