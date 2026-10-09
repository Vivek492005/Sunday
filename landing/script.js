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

/* ============ Hero background FX: binary rain / 3D warp / aurora ============ */
(function() {
  const canvas = document.querySelector('.binary-rain');
  if (!canvas) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ctx = canvas.getContext('2d');
  const WORDS = ['SUNDAY', 'AGENT', 'HAPPY_CODING!'];
  let W = 0, H = 0, raf = null, mode = 'aurora';
  let cols = [], stars = [], bands = [], floaters = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initMode();
  }

  function isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }
  function fadeColor(alpha) {
    return isLight() ? 'rgba(255,251,235,' + alpha + ')' : 'rgba(10,10,15,' + alpha + ')';
  }

  function initMode() {
    if (mode === 'binary') {
      const FONT = 14, n = Math.ceil(W / FONT);
      cols = Array.from({ length: n }, () => ({
        y: Math.random() * -H, speed: 1 + Math.random() * 2.5,
        word: Math.random() < 0.06 ? WORDS[Math.random() * WORDS.length | 0] : null, wi: 0
      }));
    } else if (mode === 'warp') {
      const n = Math.min(260, Math.floor(W * H / 9000));
      stars = Array.from({ length: n }, () => spawnStar(true));
    } else if (mode === 'aurora') {
      // Flowing rainbow northern-lights bands + floating feature words
      const palette = [
        [239, 68, 68],    // red
        [249, 115, 22],   // orange
        [245, 158, 11],   // amber
        [250, 204, 21],   // yellow
        [34, 197, 94],    // green
        [59, 130, 246],   // blue
        [168, 85, 247],   // violet
        [236, 72, 153]    // pink
      ];
      bands = palette.map(function (rgb, i) {
        return {
          rgb: rgb,
          baseY: H * (0.08 + i * 0.115),
          amp: 40 + Math.random() * 70,
          len: 0.0016 + Math.random() * 0.0018,
          speed: 0.00022 + Math.random() * 0.00028,
          phase: Math.random() * Math.PI * 2,
          phase2: Math.random() * Math.PI * 2,
          thickness: 55 + Math.random() * 80,
          alpha: 0.09 + Math.random() * 0.07
        };
      });
      // Feature words that drift through the aurora like leaves on a stream
      const FEATURES = [
        '🤖 AI Agents', '🔥 Streaks', '⚡ Zero-config', '🌐 Browser Control',
        '👥 Parallel Agents', '🔄 Auto-update', '🎯 Best-of-N', '🧠 Second Brain',
        '📅 Scheduler', '🛡️ Open Source', '🎮 Gamified', '💰 ₹149/mo'
      ];
      floaters = FEATURES.map(function (text, i) {
        return {
          text: text,
          x: Math.random() * W,
          y: Math.random() * H,
          vx: 0.15 + Math.random() * 0.35,
          vy: (Math.random() - 0.5) * 0.2,
          life: Math.random(),           // 0..1 fade cycle position
          lifeSpeed: 0.0008 + Math.random() * 0.0012,
          size: 13 + Math.random() * 8,
          hue: (i * 47) % 360
        };
      });
    }
  }

  /* ---- binary rain frame ---- */
  function binaryFrame() {
    ctx.fillStyle = fadeColor(0.12);
    ctx.fillRect(0, 0, W, H);
    ctx.font = '14px monospace';
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i], x = i * 14;
      let ch, color;
      if (c.word) {
        ch = c.word[c.wi % c.word.length]; color = '#f59e0b'; c.wi++;
        if (c.wi >= c.word.length * 3) { c.word = null; c.wi = 0; }
      } else {
        ch = Math.random() < 0.5 ? '0' : '1'; color = 'rgba(120,120,140,0.55)';
        if (Math.random() < 0.02) { c.word = WORDS[Math.random() * WORDS.length | 0]; c.wi = 0; }
      }
      ctx.fillStyle = color;
      ctx.fillText(ch, x, c.y);
      c.y += c.speed * 7;
      if (c.y > H + 14) { c.y = Math.random() * -100; c.word = null; c.wi = 0; }
    }
  }

  /* ---- 3D starfield warp frame ---- */
  function spawnStar(anywhere) {
    return {
      x: (Math.random() - .5) * W * 2, y: (Math.random() - .5) * H * 2,
      z: anywhere ? Math.random() * W : W,
      px: 0, py: 0, hot: Math.random() < 0.18
    };
  }
  function warpFrame() {
    ctx.fillStyle = fadeColor(0.35);
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, speed = 14;
    for (const s of stars) {
      const pz = s.z;
      s.z -= speed;
      if (s.z <= 1) Object.assign(s, spawnStar(false));
      const sx = cx + (s.x / s.z) * cx, sy = cy + (s.y / s.z) * cy;
      const px = cx + (s.x / pz) * cx, py = cy + (s.y / pz) * cy;
      const bright = 1 - s.z / W;
      ctx.strokeStyle = s.hot
        ? 'rgba(245,158,11,' + (0.25 + bright * 0.75) + ')'
        : 'rgba(160,160,190,' + (0.15 + bright * 0.7) + ')';
      ctx.lineWidth = 1 + bright * 2;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx, sy); ctx.stroke();
    }
  }

  /* ---- aurora (northern lights) frame ---- */
  function auroraFrame(t) {
    ctx.fillStyle = fadeColor(0.16);
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const step = 14;
    for (const b of bands) {
      for (let x = 0; x <= W; x += step) {
        // Layered sines = organic, ever-changing curtains of light
        const y = b.baseY
          + Math.sin(x * b.len + t * b.speed + b.phase) * b.amp
          + Math.sin(x * b.len * 2.7 + t * b.speed * 1.6 + b.phase2) * b.amp * 0.35;
        const flicker = 0.75 + 0.25 * Math.sin(t * 0.0006 + b.phase + x * 0.002);
        const g = ctx.createRadialGradient(x, y, 0, x, y, b.thickness);
        const col = b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2];
        g.addColorStop(0, 'rgba(' + col + ',' + (b.alpha * flicker) + ')');
        g.addColorStop(1, 'rgba(' + col + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - step, y - b.thickness, step * 2, b.thickness * 2);
      }
    }
    // Sparse drifting sparks for depth
    ctx.fillStyle = 'rgba(251,191,36,0.5)';
    for (let i = 0; i < 24; i++) {
      const sx = (i * 197.3 + t * 0.008 * (1 + (i % 3) * 0.4)) % (W + 40) - 20;
      const sy = (i * 311.7) % H + Math.sin(t * 0.0004 + i) * 30;
      const r = 0.6 + (i % 3) * 0.5;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
    }
    // Floating feature words — drift with the aurora, fade in/out like breathing
    ctx.textAlign = 'center';
    for (const f of floaters) {
      f.x += f.vx; f.y += f.vy + Math.sin(t * 0.0005 + f.x * 0.01) * 0.15;
      f.life += f.lifeSpeed;
      if (f.life > 1) {
        f.life = 0;
        f.x = -80; f.y = Math.random() * H; // respawn from left
      }
      if (f.x > W + 80) { f.x = -80; f.y = Math.random() * H; f.life = 0; }
      const fade = Math.sin(f.life * Math.PI); // 0 → 1 → 0
      if (fade <= 0.02) continue;
      ctx.font = '600 ' + f.size + 'px system-ui, sans-serif';
      ctx.fillStyle = 'hsla(' + f.hue + ', 85%, 72%, ' + (fade * 0.85) + ')';
      ctx.shadowColor = 'hsla(' + f.hue + ', 90%, 60%, ' + (fade * 0.8) + ')';
      ctx.shadowBlur = 12;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  function tick(t) {
    if (mode === 'binary') binaryFrame();
    else if (mode === 'warp') warpFrame();
    else auroraFrame(t || 0);
    raf = requestAnimationFrame(tick);
  }

  function setMode(m) {
    mode = m;
    try { localStorage.setItem('sunday-bg-fx', m); } catch (e) {}
    document.querySelectorAll('.bg-fx-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fx === m);
    });
    initMode();
  }

  function start() { if (!raf) { resize(); tick(); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  /* ---- side switcher UI ---- */
  const switcher = document.createElement('div');
  switcher.className = 'bg-fx-switcher';
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Background animation');
  [['binary', '🌧️', 'Binary rain'], ['warp', '✨', '3D starfield warp'], ['aurora', '🌌', 'Aurora borealis']]
    .forEach(function ([m, icon, label]) {
      const b = document.createElement('button');
      b.className = 'bg-fx-btn'; b.dataset.fx = m;
      b.textContent = icon; b.title = label; b.setAttribute('aria-label', label);
      b.addEventListener('click', function () { setMode(m); });
      switcher.appendChild(b);
    });
  document.body.appendChild(switcher);

  try { mode = localStorage.getItem('sunday-bg-fx') || 'aurora'; } catch (e) {}
  if (!['binary', 'warp', 'aurora'].includes(mode)) mode = 'aurora';

  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  window.addEventListener('resize', resize);
  if (!reduced) { setMode(mode); start(); }
  else { resize(); binaryFrame(); } // static first frame for reduced motion
})();

// Story video modal
(function() {
  const link = document.getElementById('story-link');
  const modal = document.getElementById('story-modal');
  const video = document.getElementById('story-video');
  const closeBtn = modal ? modal.querySelector('.vs-modal-close') : null;
  if (!link || !modal) return;
  function open(e) {
    e.preventDefault();
    modal.classList.add('open');
    video.play().catch(function(){});
    document.body.style.overflow = 'hidden';
  }
  function close() {
    modal.classList.remove('open');
    video.pause();
    document.body.style.overflow = '';
  }
  link.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') close(); });
  // Banner close button
  const bannerClose = document.querySelector('.vs-banner-close');
  const banner = document.querySelector('.vs-banner');
  if (bannerClose && banner) bannerClose.addEventListener('click', function() { banner.style.display = 'none'; });
})();

// Theme toggle (dark <-> light), persisted
(function() {
  const btn = document.querySelector('.vs-theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  function apply(theme) {
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    try { localStorage.setItem('sunday-theme', theme); } catch (e) {}
  }
  let initial = 'dark';
  try {
    initial = localStorage.getItem('sunday-theme')
      || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch (e) {}
  apply(initial);
  btn.addEventListener('click', function() {
    apply(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });
})();

/* ============ Card scroll-reveal entrance ============ */
(function() {
  const cards = document.querySelectorAll('.vs-card, .vs-wn-card');
  if (!cards.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  cards.forEach(function (c, i) {
    c.classList.add('reveal');
    c.style.transitionDelay = (i % 3) * 0.08 + 's';
  });
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  cards.forEach(function (c) { io.observe(c); });
})();

/* ============ The Sunday Journey — scroll-driven horizontal story ============ */
(function() {
  const wrap = document.querySelector('.journey-wrap');
  const pin = document.querySelector('.journey-pin');
  const track = document.querySelector('.journey-track');
  if (!wrap || !pin || !track) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.innerWidth <= 820) return; // mobile uses fallback stack

  const scenes = Array.from(track.querySelectorAll('.j-scene'));
  const dots = Array.from(document.querySelectorAll('.j-dot'));
  const glowPath = document.getElementById('journeyPathGlow');
  const orbs = document.querySelectorAll('.j-orb');
  const hint = document.querySelector('.journey-hint');
  let pathLen = 0;
  try { pathLen = glowPath.getTotalLength(); } catch (e) { pathLen = 4000; }
  glowPath.style.strokeDasharray = pathLen;
  glowPath.style.strokeDashoffset = pathLen;

  let target = 0, current = 0, rafId = null;

  function maxShift() {
    return Math.max(0, track.scrollWidth - window.innerWidth);
  }

  function onScroll() {
    const r = wrap.getBoundingClientRect();
    const scrollable = wrap.offsetHeight - window.innerHeight;
    target = Math.min(1, Math.max(0, -r.top / scrollable));
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = null;
    // Buttery lerp toward target
    current += (target - current) * 0.075;
    if (Math.abs(target - current) < 0.0004) current = target;

    // Horizontal travel
    track.style.transform = 'translate3d(' + (-current * maxShift()) + 'px,0,0)';

    // Thread draws with progress
    glowPath.style.strokeDashoffset = pathLen * (1 - current);

    // Parallax orbs drift at different rates
    orbs.forEach(function (o, i) {
      const depth = 0.12 + i * 0.09;
      o.style.transform = 'translate3d(' + (-current * maxShift() * depth) + 'px,' + (Math.sin(current * 6 + i * 2) * 24) + 'px,0)';
    });

    // 3D carousel tilt — cards rotate like passing panels (Wispr-style)
    const trackX = -current * maxShift();
    const vc = window.innerWidth / 2;
    let best = 0, bestDist = Infinity;
    scenes.forEach(function (s, i) {
      const c = trackX + s.offsetLeft + s.offsetWidth / 2;
      const d = c - vc; // signed: negative = left of center
      const ad = Math.abs(d);
      if (ad < bestDist) { bestDist = ad; best = i; }
      // Tilt: left cards rotateY(+), right cards rotateY(-), max ~28deg
      const norm = Math.max(-1, Math.min(1, d / (window.innerWidth * 0.55)));
      const rotY = norm * -26;
      const scale = 1 - Math.min(0.22, ad / window.innerWidth * 0.5);
      const z = -Math.min(220, ad * 0.45); // depth pushback
      const yArc = Math.min(46, ad * ad / window.innerWidth * 0.14); // subtle arc dip
      s.style.transform = 'translate3d(0,' + yArc + 'px,' + z + 'px) rotateY(' + rotY + 'deg) scale(' + scale.toFixed(3) + ')';
    });
    scenes.forEach(function (s, i) { s.classList.toggle('active', i === best); });
    dots.forEach(function (d, i) { d.classList.toggle('on', i === best); });

    // Fade the hint once journey starts
    if (hint) hint.style.opacity = current > 0.02 ? '0' : '';

    if (current !== target) rafId = requestAnimationFrame(tick);
  }

  // Dot navigation — smooth scroll to scene position
  dots.forEach(function (d) {
    d.addEventListener('click', function() {
      const i = parseInt(d.dataset.goto, 10);
      const scrollable = wrap.offsetHeight - window.innerHeight;
      const y = wrap.offsetTop + scrollable * (i / (scenes.length - 1));
      window.scrollTo({ top: y, behavior: 'smooth' });
    });
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
})();

/* ============ Animation Pack JS ============ */
(function() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 1. Scroll progress bar */
  const prog = document.querySelector('.scroll-progress span');
  function updateProgress() {
    if (!prog) return;
    const h = document.documentElement;
    const p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
    prog.style.transform = 'scaleX(' + Math.min(1, Math.max(0, p)) + ')';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();

  /* 2. Typewriter for hero h1 */
  const tw = document.querySelector('.typewriter');
  function renderTw(upto) {
    const text = tw.dataset.text || '';
    const aiPos = text.indexOf('AI');
    let out = text.slice(0, upto);
    if (upto >= aiPos + 2) out = out.split('AI').join('<span class="ai-accent">AI</span>');
    tw.innerHTML = out;
  }
  if (tw && !reduced) {
    const text = tw.dataset.text || '';
    let i = 0;
    (function type() {
      if (i <= text.length) {
        renderTw(i); i++;
        setTimeout(type, 34 + Math.random() * 44);
      } else {
        const caret = document.querySelector('.type-caret');
        if (caret) setTimeout(function() { caret.style.display = 'none'; }, 2500);
      }
    })();
  } else if (tw) {
    renderTw((tw.dataset.text || '').length);
    const caret = document.querySelector('.type-caret');
    if (caret) caret.style.display = 'none';
  }

  /* 3. Number counters */
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length && !reduced) {
    const cio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        const el = e.target, end = parseInt(el.dataset.count, 10);
        cio.unobserve(el);
        const t0 = performance.now(), dur = 1400;
        (function step(t) {
          const p = Math.min(1, (t - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(end * eased);
          if (p < 1) requestAnimationFrame(step);
        })(t0);
      });
    }, { threshold: 0.5 });
    counters.forEach(function (c) { cio.observe(c); });
  } else {
    counters.forEach(function (c) { c.textContent = c.dataset.count; });
  }

  /* 4. Terminal demo — agent session simulation */
  const termBody = document.getElementById('termBody');
  if (termBody && !reduced) {
    const lines = [
      { t: '<span class="tp">$</span> sunday agent "add dark mode to settings"', c: 'cmd' },
      { t: '<span class="td">◈ swarm: 4 subtasks → kanban</span>', c: 'dim' },
      { t: '<span class="td">◈ agents: 3 parallel · orchestrator active</span>', c: 'dim' },
      { t: '<span class="tg">✓</span> theme.css updated <span class="td">(agent-2)</span>', c: 'ok' },
      { t: '<span class="tg">✓</span> settings.tsx refactored <span class="td">(agent-1)</span>', c: 'ok' },
      { t: '<span class="tg">✓</span> tests pass 48/48 <span class="td">(verifier)</span>', c: 'ok' },
      { t: '<span class="tp">$</span> <span class="td">done in 2m 14s — streak +1 🔥</span>', c: 'done' },
    ];
    // strip emoji from terminal (keep professional)
    lines[6].t = '<span class="tp">$</span> <span class="td">done in 2m 14s — streak +1</span>';
    let li = 0;
    function nextLine() {
      if (li >= lines.length) { setTimeout(function() { termBody.innerHTML = ''; li = 0; nextLine(); }, 5000); return; }
      const div = document.createElement('div');
      div.innerHTML = lines[li].t;
      div.style.opacity = '0';
      div.style.transform = 'translateY(6px)';
      div.style.transition = 'opacity .35s, transform .35s';
      termBody.appendChild(div);
      requestAnimationFrame(function() { div.style.opacity = '1'; div.style.transform = 'none'; });
      li++;
      setTimeout(nextLine, 650 + Math.random() * 500);
    }
    const tio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { tio.disconnect(); nextLine(); } });
    }, { threshold: 0.3 });
    tio.observe(termBody);
  }

  /* 5. Magnetic button */
  const mag = document.querySelector('.magnetic');
  if (mag && !reduced && window.matchMedia('(pointer: fine)').matches) {
    mag.addEventListener('mousemove', function (e) {
      const r = mag.getBoundingClientRect();
      const x = (e.clientX - r.left - r.width / 2) * 0.28;
      const y = (e.clientY - r.top - r.height / 2) * 0.32;
      mag.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) scale(1.04)';
    });
    mag.addEventListener('mouseleave', function () { mag.style.transform = ''; });
  }

  /* 6. Spotlight cards — cursor glow follows mouse */
  if (!reduced && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.vs-card, .vs-wn-card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }

  /* 7. Tilt on hover for feature/whatsnew cards */
  if (!reduced && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.vs-card, .vs-wn-card').forEach(function (card) {
      card.classList.add('tilt');
      card.addEventListener('mousemove', function (e) {
        const r = card.getBoundingClientRect();
        const rx = ((e.clientY - r.top) / r.height - 0.5) * -10;
        const ry = ((e.clientX - r.left) / r.width - 0.5) * 12;
        card.style.transform = 'perspective(800px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-6px)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  /* 8. Parallax sections — subtle drift on scroll */
  if (!reduced) {
    const pEls = document.querySelectorAll('.vs-section > h2, .journey-intro');
    let pTick = false;
    window.addEventListener('scroll', function () {
      if (pTick) return; pTick = true;
      requestAnimationFrame(function () {
        pTick = false;
        const vh = window.innerHeight;
        pEls.forEach(function (el) {
          const r = el.getBoundingClientRect();
          const prog = (r.top + r.height / 2 - vh / 2) / vh; // -0.5..0.5-ish
          el.style.transform = 'translateY(' + (prog * -26).toFixed(1) + 'px)';
        });
      });
    }, { passive: true });
  }
})();
