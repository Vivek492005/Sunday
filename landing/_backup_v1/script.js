/* ============ SUNDAY LANDING — INTERACTIVITY ============ */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Mobile menu ---------- */
  var navToggle = document.getElementById('nav-toggle');
  var mobileMenu = document.getElementById('mobile-menu');
  if (navToggle && mobileMenu) {
    navToggle.addEventListener('click', function () {
      var open = mobileMenu.hasAttribute('hidden');
      if (open) {
        mobileMenu.removeAttribute('hidden');
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Close menu');
      } else {
        mobileMenu.setAttribute('hidden', '');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', 'Open menu');
      }
    });
    mobileMenu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        mobileMenu.setAttribute('hidden', '');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---------- Nav shrink on scroll ---------- */
  var nav = document.getElementById('nav');
  window.addEventListener('scroll', function () {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });

  /* ---------- GitHub star count (non-blocking, cached) ---------- */
  var starEl = document.getElementById('star-count');
  if (starEl) {
    try {
      var cached = sessionStorage.getItem('sunday-stars');
      if (cached) {
        starEl.textContent = '★ ' + cached;
      } else {
        fetch('https://api.github.com/repos/Vivek492005/Sunday')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && typeof d.stargazers_count === 'number') {
              var s = d.stargazers_count >= 1000
                ? (d.stargazers_count / 1000).toFixed(1) + 'k'
                : String(d.stargazers_count);
              starEl.textContent = '★ ' + s;
              sessionStorage.setItem('sunday-stars', s);
            }
          })
          .catch(function () { /* silent */ });
      }
    } catch (e) { /* storage unavailable */ }
  }

  /* ---------- Live GitHub stats (stars / forks / watchers / issues) ---------- */
  (function liveGitHubStats() {
    var map = { stargazers_count: 'gh-stars', forks_count: 'gh-forks', watchers_count: 'gh-watchers', open_issues_count: 'gh-issues' };
    var els = {};
    var found = false;
    Object.keys(map).forEach(function (k) {
      var el = document.getElementById(map[k]);
      if (el) { els[k] = el; found = true; }
    });
    if (!found) return;
    function fmt(n) {
      if (typeof n !== 'number') return '—';
      return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    }
    // Show cached values instantly, then refresh live
    try {
      var cached = sessionStorage.getItem('sunday-gh-stats');
      if (cached) {
        var c = JSON.parse(cached);
        Object.keys(els).forEach(function (k) { if (typeof c[k] === 'number') els[k].textContent = fmt(c[k]); });
      }
    } catch (e) { /* ignore */ }
    fetch('https://api.github.com/repos/Vivek492005/Sunday')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || typeof d.stargazers_count !== 'number') return;
        Object.keys(els).forEach(function (k) { els[k].textContent = fmt(d[k]); });
        try { sessionStorage.setItem('sunday-gh-stats', JSON.stringify(d)); } catch (e) { /* ignore */ }
      })
      .catch(function () { /* keep cached or placeholder */ });
  })();

  /* ---------- Scroll reveals ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (entry.isIntersecting) {
          entry.target.style.transitionDelay = (i % 6 * 80) + 'ms';
          entry.target.classList.add('visible');
          ro.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { ro.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ---------- Animated count-ups ---------- */
  var counters = document.querySelectorAll('[data-count]');
  function countUp(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    if (reducedMotion) { el.textContent = '~' + target.toLocaleString(); return; }
    var dur = 1400, start = null;
    function tick(t) {
      if (!start) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = '~' + Math.floor(eased * target).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  if ('IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { countUp(entry.target); co.unobserve(entry.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { co.observe(el); });
  } else {
    counters.forEach(countUp);
  }

  /* ---------- Hero typing cycler ---------- */
  var typerText = document.getElementById('typer-text');
  var prompts = [
    'sunday chat "add JWT auth to the login route"',
    'sunday chat "find the N+1 query and fix it"',
    'sunday chat "write tests for the checkout flow"'
  ];
  if (typerText) {
    var pi = 0, ci = 0, deleting = false;
    if (reducedMotion) {
      typerText.textContent = prompts[0];
    } else {
      (function type() {
        var full = prompts[pi];
        if (!deleting) {
          ci++;
          typerText.textContent = full.slice(0, ci);
          if (ci === full.length) {
            deleting = true;
            setTimeout(type, 2200);
            return;
          }
          setTimeout(type, 28 + Math.random() * 40);
        } else {
          ci--;
          typerText.textContent = full.slice(0, ci);
          if (ci === 0) {
            deleting = false;
            pi = (pi + 1) % prompts.length;
            setTimeout(type, 500);
            return;
          }
          setTimeout(type, 14);
        }
      })();
    }
  }

  /* ---------- Particle canvas (hero) ---------- */
  var canvas = document.getElementById('particles');
  if (canvas && !reducedMotion) {
    var ctx = canvas.getContext('2d');
    var particles = [], running = true, W = 0, H = 0;
    function resize() {
      var r = canvas.parentElement.getBoundingClientRect();
      W = canvas.width = r.width; H = canvas.height = r.height;
    }
    function spawn() {
      particles = [];
      for (var i = 0; i < 70; i++) {
        particles.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
          r: Math.random() * 2 + 0.5,
          hue: Math.random() < 0.7 ? '247,197,72' : '0,240,255',
          a: Math.random() * 0.5 + 0.15
        });
      }
    }
    function frame() {
      if (!running) { requestAnimationFrame(frame); return; }
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + p.hue + ',' + p.a + ')';
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    resize(); spawn(); frame();
    window.addEventListener('resize', function () { resize(); spawn(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        running = entries[0].isIntersecting;
      }).observe(document.getElementById('hero'));
    }
  }

  /* ---------- 3D tilt ---------- */
  if (!reducedMotion && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('.tilt').forEach(function (el) {
      var frame = el.querySelector('.editor-frame') || el;
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var rx = ((e.clientY - r.top) / r.height - 0.5) * -10;
        var ry = ((e.clientX - r.left) / r.width - 0.5) * 12;
        rx = Math.max(-8, Math.min(8, rx));
        ry = Math.max(-8, Math.min(8, ry));
        frame.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
      });
      el.addEventListener('mouseleave', function () {
        frame.style.transform = '';
      });
    });
    /* Subtle tilt on feature cards */
    document.querySelectorAll('#features .card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var rx = ((e.clientY - r.top) / r.height - 0.5) * -6;
        var ry = ((e.clientX - r.left) / r.width - 0.5) * 6;
        card.style.transform = 'perspective(900px) rotateX(' + rx + 'deg) rotateY(' + ry + 'deg) translateY(-4px)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  /* ---------- How-it-works auto-advance ---------- */
  var steps = document.querySelectorAll('.flow-step');
  if (steps.length && !reducedMotion) {
    var si = 0, paused = false;
    function advance() {
      if (!paused) {
        steps.forEach(function (s) { s.classList.remove('active'); });
        steps[si].classList.add('active');
        si = (si + 1) % steps.length;
      }
    }
    steps.forEach(function (s) {
      s.addEventListener('mouseenter', function () { paused = true; });
      s.addEventListener('mouseleave', function () { paused = false; });
    });
    advance();
    setInterval(advance, 4000);
  } else if (steps.length) {
    steps[0].classList.add('active');
  }

  /* ---------- Demo: terminal typing ---------- */
  var termOut = document.getElementById('terminal-output');
  var demoLines = [
    { t: '$ sunday chat "add rate limiting to the API"', c: 't-prompt', speed: 34 },
    { t: '☀️ Planning… 3 steps', c: 't-agent', speed: 20 },
    { t: '  → Reading src/api/routes.ts', c: '', speed: 16 },
    { t: '  → Editing src/api/middleware.ts  +42 −8', c: '', speed: 16 },
    { t: '  → Running tests…', c: '', speed: 16 },
    { t: '✓ Tests pass (12/12)', c: 't-ok', speed: 20 },
    { t: '✓ Diff ready for review — 2 files changed', c: 't-ok', speed: 20 }
  ];
  var demoPlayed = false, demoTimer = null;
  function playDemo() {
    if (!termOut) return;
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    termOut.innerHTML = '';
    if (reducedMotion) {
      demoLines.forEach(function (l) {
        var div = document.createElement('div');
        if (l.c) div.className = l.c;
        div.textContent = l.t;
        termOut.appendChild(div);
      });
      return;
    }
    var li = 0, ci2 = 0, lineEl = null;
    function nextChar() {
      if (li >= demoLines.length) return;
      var line = demoLines[li];
      if (!lineEl) {
        lineEl = document.createElement('div');
        if (line.c) lineEl.className = line.c;
        termOut.appendChild(lineEl);
      }
      ci2++;
      lineEl.textContent = line.t.slice(0, ci2);
      if (ci2 >= line.t.length) {
        li++; ci2 = 0; lineEl = null;
        demoTimer = setTimeout(nextChar, 320);
      } else {
        demoTimer = setTimeout(nextChar, line.speed);
      }
    }
    nextChar();
  }
  var replayBtn = document.getElementById('replay');
  if (replayBtn) replayBtn.addEventListener('click', playDemo);
  if ('IntersectionObserver' in window && termOut) {
    var demoObs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !demoPlayed) {
        demoPlayed = true;
        setTimeout(playDemo, 400);
        demoObs.disconnect();
      }
    }, { threshold: 0.35 });
    demoObs.observe(termOut);
  }

  /* ---------- Demo tabs ---------- */
  var tabs = document.querySelectorAll('.demo-tab');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.querySelectorAll('.demo-pane').forEach(function (p) {
        p.classList.remove('active');
      });
      var pane = document.getElementById('pane-' + tab.getAttribute('data-tab'));
      if (pane) pane.classList.add('active');
      var title = document.getElementById('demo-title');
      if (title) title.textContent = tab.textContent.trim().toLowerCase() + ' — sunday';
    });
  });

  /* ---------- Copy buttons ---------- */
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-copy');
      var src = document.getElementById(id);
      var text = src ? src.textContent : '';
      function done() {
        var orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(function () { btn.textContent = orig; }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
    });
  });

  /* ---------- OS auto-detect for download cards ---------- */
  try {
    var plat = (navigator.platform || '').toLowerCase();
    var isWin = plat.indexOf('win') >= 0;
    document.querySelectorAll('.dl-card').forEach(function (card) {
      var os = card.getAttribute('data-os');
      if ((isWin && os === 'windows') || (!isWin && os === 'other' && card.querySelector('.cmd'))) {
        card.classList.add('highlight-os');
      }
    });
  } catch (e) {}

  /* ---------- Arch layer tooltips ---------- */
  document.querySelectorAll('.arch-layer').forEach(function (layer) {
    var tip = layer.getAttribute('data-tip');
    if (tip) layer.setAttribute('title', tip.replace(/&amp;/g, '&'));
  });

  /* ---------- V2 PORT: cursor spotlight (fine pointer only) ---------- */
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var spot = document.getElementById('spotlight');
  if (spot && finePointer && !reducedMotion) {
    var sx = -600, sy = -600, tx = -600, ty = -600;
    document.addEventListener('pointermove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function spotLoop() {
      sx += (tx - sx) * 0.1; sy += (ty - sy) * 0.1;
      spot.style.left = sx + 'px'; spot.style.top = sy + 'px';
      requestAnimationFrame(spotLoop);
    })();
  } else if (spot) { spot.style.display = 'none'; }

  /* ---------- V2 PORT: magnetic primary buttons ---------- */
  if (finePointer && !reducedMotion) {
    document.querySelectorAll('.magnetic').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        var x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(x, y) < 80) {
          btn.style.transform = 'translate(' + (x * 0.08).toFixed(1) + 'px,' + (y * 0.08).toFixed(1) + 'px)';
        } else { btn.style.transform = ''; }
      });
      btn.addEventListener('pointerleave', function () { btn.style.transform = ''; });
    });
  }

})();
