/* Sunday v2 landing — pure vanilla JS, zero dependencies */
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  /* ---------- nav: scroll state + mobile menu ---------- */
  var nav = document.getElementById('nav');
  function onScrollNav() { nav.classList.toggle('scrolled', window.scrollY > 40); }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();
  var burger = document.getElementById('hamburger'), mMenu = document.getElementById('mobile-menu');
  burger.addEventListener('click', function () {
    var open = mMenu.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  mMenu.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') { mMenu.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
  });

  /* ---------- live GitHub stats (stars + forks) ---------- */
  function fmt(n) { return typeof n === 'number' ? (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)) : '…'; }
  var starEls = [document.getElementById('nav-stars'), document.getElementById('nav-stars-m'), document.getElementById('strip-stars')].filter(Boolean);
  var forkEls = [document.getElementById('strip-forks')].filter(Boolean);
  try {
    var c = JSON.parse(sessionStorage.getItem('sunday-v2-gh') || 'null');
    if (c) {
      starEls.forEach(function (el) { el.textContent = fmt(c.stars); });
      forkEls.forEach(function (el) { el.textContent = fmt(c.forks); });
    }
  } catch (e) { /* ignore */ }
  fetch('https://api.github.com/repos/Vivek492005/Sunday')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== 'number') return;
      starEls.forEach(function (el) { el.textContent = fmt(d.stargazers_count); });
      forkEls.forEach(function (el) { el.textContent = fmt(d.forks_count); });
      try { sessionStorage.setItem('sunday-v2-gh', JSON.stringify({ stars: d.stargazers_count, forks: d.forks_count })); } catch (e) { /* ignore */ }
    })
    .catch(function () { /* keep cached/placeholder */ });

  /* ---------- OS detection → download buttons ---------- */
  var VSIX = 'https://github.com/Vivek492005/Sunday/releases/download/v0.1.0/sunday-agent-0.1.0.vsix';
  var EXE = 'https://github.com/Vivek492005/Sunday/releases/download/v0.1.0/Sunday-Agent-Setup-0.1.0.exe';
  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
    if (p.indexOf('win') !== -1) return 'Windows';
    if (p.indexOf('mac') !== -1) return 'macOS';
    if (p.indexOf('linux') !== -1) return 'Linux';
    var ua = navigator.userAgent.toLowerCase();
    if (ua.indexOf('windows') !== -1) return 'Windows';
    if (ua.indexOf('macintosh') !== -1 || ua.indexOf('mac os') !== -1) return 'macOS';
    if (ua.indexOf('linux') !== -1) return 'Linux';
    return null;
  }
  var os = detectOS();
  var isWin = os === 'Windows';
  var primaryHref = isWin ? EXE : VSIX;
  var primaryLabel = os ? 'Download for ' + os : 'Download Sunday';
  var cmd = isWin ? 'Sunday-Agent-Setup-0.1.0.exe' : 'code --install-extension sunday-agent-0.1.0.vsix';
  document.getElementById('dl-os').textContent = os || 'your OS';
  document.getElementById('hero-download').href = primaryHref;
  document.getElementById('hero-download-label').textContent = primaryLabel;
  document.getElementById('dl-primary').href = primaryHref;
  document.getElementById('dl-primary-label').textContent = primaryLabel;
  document.getElementById('dl-cmd').textContent = cmd;

  /* ---------- scroll reveals ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduced) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('inview'); ro.unobserve(en.target); } });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { ro.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('inview'); });
  }

  /* ---------- count-up stats ---------- */
  var counters = document.querySelectorAll('[data-count]');
  function runCounter(el) {
    var target = parseInt(el.getAttribute('data-count'), 10), suf = el.getAttribute('data-suffix') || '';
    if (reduced) { el.textContent = target.toLocaleString('en-US') + suf; return; }
    var t0 = null, dur = 800;
    function frame(t) {
      if (!t0) t0 = t;
      var p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e).toLocaleString('en-US') + suf;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if ('IntersectionObserver' in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { runCounter(en.target); co.unobserve(en.target); } });
    }, { threshold: 0.4 });
    counters.forEach(function (el) { co.observe(el); });
  } else { counters.forEach(runCounter); }

  /* ---------- hero cursor tilt (±8°) ---------- */
  var heroVisual = document.getElementById('hero-visual'), heroTilt = document.getElementById('hero-tilt');
  if (heroVisual && finePointer && !reduced) {
    heroVisual.addEventListener('pointermove', function (e) {
      var r = heroVisual.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      heroTilt.style.transform = 'rotateY(' + (x * 16).toFixed(2) + 'deg) rotateX(' + (-y * 16).toFixed(2) + 'deg)';
    });
    heroVisual.addEventListener('pointerleave', function () { heroTilt.style.transform = 'rotateY(0deg) rotateX(0deg)'; });
  }

  /* ---------- feature card tilt (±6°) ---------- */
  if (finePointer && !reduced) {
    document.querySelectorAll('.tilt-card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(800px) rotateY(' + (x * 12).toFixed(2) + 'deg) rotateX(' + (-y * 12).toFixed(2) + 'deg) translateY(-4px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  /* ---------- cursor spotlight ---------- */
  var spot = document.getElementById('spotlight');
  if (spot && finePointer && !reduced) {
    var sx = -500, sy = -500, tx = -500, ty = -500;
    document.addEventListener('pointermove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function loop() {
      sx += (tx - sx) * 0.12; sy += (ty - sy) * 0.12;
      spot.style.left = sx + 'px'; spot.style.top = sy + 'px';
      requestAnimationFrame(loop);
    })();
  } else if (spot) { spot.style.display = 'none'; }

  /* ---------- magnetic primary buttons ---------- */
  if (finePointer && !reduced) {
    document.querySelectorAll('.magnetic').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        var x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        var d = Math.hypot(x, y);
        if (d < 70) btn.style.transform = 'translate(' + (x * 0.09).toFixed(1) + 'px,' + (y * 0.09).toFixed(1) + 'px)';
      });
      btn.addEventListener('pointerleave', function () { btn.style.transform = ''; });
    });
  }

  /* ---------- how-it-works scroll scrub ---------- */
  var howWrap = document.querySelector('.how-wrap'), howFill = document.getElementById('how-fill');
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  function scrubHow() {
    if (!howWrap) return;
    var r = howWrap.getBoundingClientRect(), vh = window.innerHeight;
    var p = (vh * 0.65 - r.top) / (r.height + vh * 0.15);
    p = Math.max(0, Math.min(1, p));
    if (reduced) p = 1;
    howFill.style.width = (p * 100).toFixed(1) + '%';
    steps.forEach(function (s, i) { s.classList.toggle('active', p >= (i + 0.6) / steps.length); });
  }
  window.addEventListener('scroll', scrubHow, { passive: true });
  window.addEventListener('resize', scrubHow);
  scrubHow();

  /* ---------- orchestration draw-in ---------- */
  var orchWrap = document.getElementById('orch-wrap');
  if (orchWrap) {
    if ('IntersectionObserver' in window && !reduced) {
      var oo = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { orchWrap.classList.add('drawn'); oo.disconnect(); } });
      }, { threshold: 0.35 });
      oo.observe(orchWrap);
    } else { orchWrap.classList.add('drawn'); }
  }

  /* ---------- architecture tooltips ---------- */
  var tip = document.getElementById('arch-tip');
  if (tip && finePointer) {
    document.querySelectorAll('.anode').forEach(function (node) {
      node.addEventListener('pointerenter', function (e) {
        tip.textContent = node.getAttribute('data-tip');
        var r = node.getBoundingClientRect();
        tip.style.left = (r.left + r.width / 2) + 'px';
        tip.style.top = Math.max(r.top, 70) + 'px';
        tip.classList.add('show');
      });
      node.addEventListener('pointerleave', function () { tip.classList.remove('show'); });
    });
  }

  /* ---------- copy buttons ---------- */
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      var text = el ? el.textContent : '';
      function done() { btn.textContent = 'Copied'; btn.classList.add('copied'); setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        document.body.removeChild(ta); done();
      }
    });
  });
})();
