/* ============================================================================
   globeviz.js — the AMBIENT GLOBE VISUALISER for MODDYS World Radio's World View.

   Ten quiet looks for the space around the globe. The page lays this canvas over
   the MapLibre globe with pointer-events off, so this file never sees a map
   pixel in its life: it is handed `geo` — the disc's centre and radius in CSS px
   — and dresses the room around it. Nothing here is data: the globe itself is
   the map's business, this is weather.

       GViz.STYLES                                           the eleven names, in index order
       GViz.draw(ctx, W, H, style, tSec, act, reduced, geo)  paint one frame
       GViz.ptr(x, y)                                        style 10 only: one pointermove
       GViz.stats()                                          style 10 only: {flowers, doves}

   The contract with whoever owns the page:

     * Each call clears first and keeps nothing. No state survives between
       frames, so a painter called twice with the same `tSec` draws the same
       picture — the ambient version of a live page can stop, resize or repaint
       without the sky ever jumping. Every particle's place, size and tint comes
       from an integer hash of its index, never Math.random; drift and twinkle
       are pure functions of `tSec`. Same sky, every frame, every session.
     * W and H are CSS pixels. The host owns devicePixelRatio, scales the
       context and stays out of our way; this file stays out of its.
     * `act` is how alive the animation should be, 0..1 — 0.18 with nothing
       playing, 0.55 while another window owns the stream, 1.0 when this one is.
       It leans brightness and motion effort up, gently: the look at 0.18 is the
       same look, asleep.
     * `reduced` composes one still frame at each look's best pose (R_POSE
       below) for callers that paint once and walk away — reduced motion must
       still be a picture, not an empty canvas — and repainting that frame is
       bit-for-bit the same painting.
     * `geo` is {cx, cy, r}: the globe disc's centre and radius in CSS px. Handed
       nothing, the disc is assumed centred with r = 0.425 * min(W, H), which is
       the default World View framing.
     * ONE EXCEPTION, style 10 "garden". It is the mouse-trail look — soft
       blossoms blooming along the pointer with a dove taking off now and then —
       and it is the only style allowed to keep state between frames: the page
       feeds it GViz.ptr(x, y) on every pointermove (CSS px, viewport coords)
       and reads GViz.stats() for the live {flowers, doves} counts (0/0 whenever
       the garden is not the look being drawn). It is also the one look allowed
       to paint OVER the map disc — the destination-out punch at the end of
       draw() is gated to styles 0-9 for exactly that reason. Under `reduced`
       it is still a single composed still: the idle cluster, painted from
       hashed seeds, no doves, no growth, and ptr() is ignored.

   Two rules shape every stroke in here:

     THE DISC LAW. The disc belongs to the map. Nothing appears inside ~0.85r;
     everything ramps in from there and is strongest just outside the rim, the
     way a planet's own sky is. `rimFade` is the gentle half of that law for the
     point-sized things; a destination-out punch at the end of draw() is the hard
     half — it is what lets the huge soft things (nebula blobs, aurora curtains,
     orbit ellipses, the scan wedge) run under the globe and stop at its edge,
     fading over the last few pixels rather than cutting. Once that punch lands,
     the alpha inside the disc is exactly zero, whatever the look painted. That
     is styles 0-9. Style 10 "garden" is the one deliberate exception: the punch
     is gated off it and it paints after the punch, because blossoms that stopped
     at an invisible circle would look broken.

     THE PALETTE AND THE BUDGET. The site's six hues plus ivory, alphas from
     about 0.04 up to 0.45 at the very brightest, never white, never a strobe,
     never a wash over the disc (the garden's blossoms are the one exception,
     and they are small things with stems, not washes). At most ~200 particles
     a frame, no per-particle shadowBlur, radial gradients only for the big soft
     glows and only a handful a frame — the aim is a frame well inside 4 ms at
     1280x900, and the same discipline on a phone.
   ============================================================================ */
window.GViz = (function () {
  "use strict";

  var STYLES = ["stars", "nebula", "aurora", "orbits", "constellations", "ripples", "comets", "motes", "pulse", "scan", "garden"];

  /* the site's palette, and the bag the little stars pick a tint from */
  var PINK = "#ff3ea5", ORANGE = "#ff9f1c", YELLOW = "#ffe14d",
      LIME = "#c9ff3d", CYAN = "#1fe3ff", PURPLE = "#a06bff", IVORY = "#f4f1ea";
  var TINT = [IVORY, IVORY, CYAN, IVORY, LIME, PURPLE, IVORY, YELLOW, PINK];

  var TAU = Math.PI * 2;

  /* the still instant each look poses at when the caller asks for `reduced` */
  var R_POSE = [5.0, 9.0, 11.0, 9.0, 8.0, 6.0, 1.5, 7.5, 4.0, 7.0, 6.0];

  /* ============================ small arithmetic ============================
     Particle i's whole existence — where it sits, how big it is, when it
     twinkles — is hashed out of i and a salt, so the sky is identical in every
     frame and every session. Nothing in this file calls Math.random. */
  var imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };
  function hash32(n) {
    n = imul(n ^ (n >>> 16), 0x85ebca6b);
    n = imul(n ^ (n >>> 13), 0xc2b2ae35);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function rnd(i, salt) {
    return hash32(imul(i + 1, 0x9e3779b1) ^ imul(salt + 1, 0x27d4eb2f)) / 4294967296;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smooth(a) { a = clamp(a, 0, 1); return a * a * (3 - 2 * a); }
  function rgba(hex, a) {
    return "rgba(" + parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16)
      + "," + parseInt(hex.slice(5, 7), 16) + "," + a + ")";
  }
  /* how far this frame still has room in it, from the centre, along `ang` —
     keeps every scatter inside the viewport whatever shape the window is */
  function edgeDist(cx, cy, W, H, ang) {
    var c = Math.cos(ang), s = Math.sin(ang), t = 1e9;
    if (c > 1e-6) t = Math.min(t, (W - cx) / c);
    else if (c < -1e-6) t = Math.min(t, -cx / c);
    if (s > 1e-6) t = Math.min(t, (H - cy) / s);
    else if (s < -1e-6) t = Math.min(t, -cy / s);
    return t < 1e8 ? t : 0;
  }
  /* the disc law's gentle half: 0 deep inside the disc, 1 from ~1.02r outward */
  function rimFade(cx, cy, r, x, y) {
    var dx = x - cx, dy = y - cy;
    return smooth((Math.sqrt(dx * dx + dy * dy) - r * 0.86) / (r * 0.16));
  }

  /* ================================ 0 stars ================================
     120 tiny stars in a very slow parallax drift around the disc, most of them
     barely there, the odd one bright enough to glow. */
  function paintStars(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.78 + 0.22 * act, spd = 0.6 + 0.4 * act;
    var i, u1, u2, u3, ang, dmax, near, rr, x, y, sz, tw, a, col;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < 120; i++) {
      u1 = rnd(i, 11); u2 = rnd(i, 23); u3 = rnd(i, 37);
      ang = u1 * TAU;
      dmax = edgeDist(cx, cy, W, H, ang);
      rr = r * 1.03 + Math.pow(u2, 1.35) * Math.max(0, dmax * 0.97 - r * 1.03);
      near = 1 - clamp((rr - r) / (r * 3.2), 0, 1);            /* nearer drifts faster */
      ang += t * spd * (0.005 + 0.020 * near) * (u3 < 0.5 ? -1 : 1);
      x = cx + Math.cos(ang) * rr;
      y = cy + Math.sin(ang) * rr;
      if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue;
      sz = 0.6 + 1.5 * Math.pow(u3, 2.2);
      tw = 0.62 + 0.38 * Math.sin(t * (0.45 + 1.3 * u1) + u2 * 12.0);
      a = (0.13 + 0.21 * u3) * tw * gain * rimFade(cx, cy, r, x, y);
      col = TINT[hash32(imul(i + 1, 0x51ed270b)) % TINT.length];
      ctx.fillStyle = col;
      if (u3 > 0.90) {                                         /* the occasional brighter star */
        ctx.globalAlpha = a * 0.24;
        ctx.beginPath(); ctx.arc(x, y, sz * 3.6, 0, TAU); ctx.fill();
        ctx.globalAlpha = clamp(a * 1.45, 0, 0.45);
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, sz * 0.85), 0, TAU); ctx.fill();
      } else {
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.45, sz * 0.75), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* =============================== 1 nebula ================================
     Four huge, very faint blobs — purple, cyan, pink — breathing so slowly you
     would have to stare for a minute to be sure they move. */
  function paintNebula(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var cols = [PURPLE, CYAN, PINK, PURPLE];
    var i, u1, u2, u3, ang, dist, bx, by, R, a, g;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < 4; i++) {
      u1 = rnd(i, 61); u2 = rnd(i, 67); u3 = rnd(i, 71);
      ang = u1 * TAU + i * 1.4;
      dist = r * (1.00 + 0.70 * u2);
      bx = cx + Math.cos(ang) * dist + Math.sin(t * 0.021 + i * 2.1) * r * 0.08;
      by = cy + Math.sin(ang) * dist + Math.cos(t * 0.017 + i * 1.3) * r * 0.06;
      R = r * (0.70 + 0.60 * u3);
      a = (0.05 + 0.035 * act) * (0.75 + 0.5 * u3);            /* alpha 0.05 .. 0.11 */
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(1.22, 0.80);
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      g.addColorStop(0, rgba(cols[i], a));
      g.addColorStop(0.45, rgba(cols[i], a * 0.55));
      g.addColorStop(1, rgba(cols[i], 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* =============================== 2 aurora ================================
     Two wavy curtains of light along the top of the view, one whisper along the
     bottom, cyan into lime into purple, hanging from a wavy crest with a soft
     vertical falloff. The vertical striation is deliberately almost too faint
     to see: light with a texture in it, not a corrugated sheet. */
  function paintAurora(ctx, W, H, t, act, geo) {
    var gain = 0.72 + 0.28 * act, spd = 0.6 + 0.4 * act;
    var bands = [
      { y: H * 0.075, amp: H * 0.035, hgt: H * 0.24, col: CYAN,   a: 0.115, k: 0.0055, ph: 0.0, dr: 1 },
      { y: H * 0.165, amp: H * 0.050, hgt: H * 0.18, col: LIME,   a: 0.085, k: 0.0040, ph: 2.1, dr: 1 },
      { y: H * 0.955, amp: H * 0.030, hgt: -H * 0.16, col: PURPLE, a: 0.060, k: 0.0048, ph: 4.2, dr: -1 }
    ];
    var step = 12, i, s, x0, y0, g, b, stri;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < bands.length; i++) {
      b = bands[i];
      if (b.hgt > 0) {                                          /* hangs down from the crest */
        g = ctx.createLinearGradient(0, b.y - b.amp, 0, b.y - b.amp + b.hgt);
        g.addColorStop(0, rgba(b.col, 1));
        g.addColorStop(0.55, rgba(b.col, 0.35));
        g.addColorStop(1, rgba(b.col, 0));
      } else {                                                  /* rises from the trough */
        g = ctx.createLinearGradient(0, b.y + b.amp + b.hgt, 0, b.y + b.amp);
        g.addColorStop(0, rgba(b.col, 0));
        g.addColorStop(0.45, rgba(b.col, 0.35));
        g.addColorStop(1, rgba(b.col, 1));
      }
      ctx.fillStyle = g;
      for (s = 0, x0 = -step; x0 < W + step; s++, x0 += step) {
        var xs = Math.round(x0);            /* exact tiling: no doubled-alpha seams */
        y0 = b.y + Math.sin(xs * b.k + t * spd * (0.30 + 0.22 * b.dr) + b.ph) * b.amp;
        stri = 0.88 + 0.12 * Math.sin(xs * 0.0115 + t * 0.45 + b.ph * 3.0);
        ctx.globalAlpha = b.a * gain * stri;
        ctx.fillRect(xs, y0, step, b.hgt);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* =============================== 3 orbits ================================
     Three faint rings around the disc out of one nested family — same lantern,
     three distances, so they read as a ring system and not as three ellipses
     arguing — each with a small glowing moon travelling along it. The moons
     vanish behind the globe on the far half of their ring: the map does the
     occulting, the punch below does the trimming. */
  function paintOrbits(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.80 + 0.20 * act, i, R, am, mx, my, g;
    var rings = [
      { rr: 1.18, sq: 0.42, tilt: -0.40, col: CYAN,   sp: 0.15, ph: 0.6, mcol: IVORY },
      { rr: 1.42, sq: 0.52, tilt: -0.24, col: PURPLE, sp: -0.10, ph: 2.6, mcol: CYAN },
      { rr: 1.70, sq: 0.62, tilt: -0.10, col: PINK,   sp: 0.08, ph: 4.4, mcol: IVORY }
    ];
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < rings.length; i++) {
      R = rings[i];
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(R.tilt);
      ctx.scale(1, R.sq);
      ctx.strokeStyle = rgba(R.col, 0.045 * gain);             /* the ring: a whisper, twice */
      ctx.lineWidth = 3.0;
      ctx.beginPath(); ctx.arc(0, 0, r * R.rr, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(R.col, 0.105 * gain);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, r * R.rr, 0, TAU); ctx.stroke();
      am = t * R.sp + R.ph;
      mx = Math.cos(am) * r * R.rr;
      my = Math.sin(am) * r * R.rr;
      g = ctx.createRadialGradient(mx, my, 0, mx, my, 11);
      g.addColorStop(0, rgba(R.mcol, 0.42));
      g.addColorStop(0.45, rgba(R.mcol, 0.15));
      g.addColorStop(1, rgba(R.mcol, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(mx, my, 11, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(IVORY, 0.45);
      ctx.beginPath(); ctx.arc(mx, my, 1.6, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* =========================== 4 constellations ===========================
     18 stars around the disc with thin lines between them, each line forming,
     holding and fading on its own slow clock, so the figure never quite settles.
     A star wears a little of the light of its currently-lit lines, and a scatter
     of much dimmer stars keeps the rest of the sky feeling like sky. */
  function paintConstellations(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.75 + 0.25 * act;
    var N = 18, P = [], i, j, k, u1, u2, ang, dmax, dd, a, lit, ph, u, al;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = IVORY;
    for (i = 0; i < 40; i++) {                          /* the dim sky behind the figure */
      u1 = rnd(i, 811); u2 = rnd(i, 823);
      ang = u1 * TAU;
      dmax = edgeDist(cx, cy, W, H, ang);
      dd = r * 1.03 + Math.pow(u2, 1.3) * Math.max(0, dmax * 0.96 - r * 1.03);
      ctx.globalAlpha = (0.06 + 0.13 * rnd(i, 829))
        * (0.6 + 0.4 * Math.sin(t * (0.4 + u2) + u1 * 9.0)) * gain;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * dd, cy + Math.sin(ang) * dd, 0.7 + 0.7 * u1, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < N; i++) {
      u1 = rnd(i, 101); u2 = rnd(i, 103);
      ang = u1 * TAU;
      dmax = edgeDist(cx, cy, W, H, ang);
      dd = r * 1.06 + Math.pow(u2, 0.85) * Math.max(0, Math.min(r * 1.25, dmax * 0.90) - r * 1.06);
      P.push({
        x: cx + Math.cos(ang) * dd,
        y: cy + Math.sin(ang) * dd,
        tw: 0.55 + 0.45 * Math.sin(t * (0.4 + 0.9 * rnd(i, 107)) + u1 * 9.0),
        lit: 0
      });
    }
    ctx.lineWidth = 1;
    /* two links per star: the ring itself and a chord, so the figure looks drawn
       rather than chained */
    for (i = 0; i < N; i++) {
      for (k = 0; k < 2; k++) {
        j = k ? (i + 5) % N : (i + 1) % N;
        if (j <= i) continue;                                   /* each link once */
        ph = rnd(i * 31 + j * 7, 151) * TAU;
        u = 0.5 + 0.5 * Math.sin(t * (0.14 + 0.10 * rnd(i + j, 157)) * (0.6 + 0.4 * act) + ph);
        al = Math.pow(u, 3.0) * 0.13 * gain;
        P[i].lit = Math.max(P[i].lit, al);
        P[j].lit = Math.max(P[j].lit, al);
        if (al < 0.004) continue;
        if (P[i].x < -20 || P[i].x > W + 20 || P[i].y < -20 || P[i].y > H + 20) continue;
        if (P[j].x < -20 || P[j].x > W + 20 || P[j].y < -20 || P[j].y > H + 20) continue;
        ctx.strokeStyle = rgba(TINT[(i + j) % TINT.length], al);
        ctx.beginPath();
        ctx.moveTo(P[i].x, P[i].y);
        ctx.lineTo(P[j].x, P[j].y);
        ctx.stroke();
      }
    }
    /* then the stars themselves, alight with whatever lines are lit */
    for (i = 0; i < N; i++) {
      if (P[i].x < -12 || P[i].x > W + 12 || P[i].y < -12 || P[i].y > H + 12) continue;
      lit = P[i].lit;
      a = clamp((0.15 + 22 * lit) * P[i].tw * gain, 0, 0.45);
      ctx.globalAlpha = clamp(a * 0.20, 0, 0.12);
      ctx.beginPath(); ctx.arc(P[i].x, P[i].y, 4.2, 0, TAU); ctx.fill();
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(P[i].x, P[i].y, 1.15, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* =============================== 5 ripples ==============================
     A faint ring leaves the rim every four seconds and fades as it runs
     outward — the radio-wave motif, but quiet enough to live behind a map.
     Three rings are aloft at once, evenly spaced, so the ladder reads. */
  function paintRipples(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.80 + 0.20 * act;
    var CAD = 4.0, NR = 3, WHEEL = CAD * NR;
    var i, age, R, f, a, col;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < NR; i++) {
      age = ((t - i * CAD) % WHEEL + WHEEL) % WHEEL;
      R = r + age * (r * 0.22);
      f = smooth(age / 0.30) * (1 - clamp((R - r) / (r * 1.8), 0, 1));
      a = 0.10 * f * gain;
      if (a < 0.004) continue;
      col = i === 1 ? LIME : (i === 2 ? PURPLE : CYAN);
      ctx.strokeStyle = rgba(col, a * 0.35);
      ctx.lineWidth = 3.6;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(col, a);
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* ================================ 6 comets ==============================
     Mostly empty sky with a scatter of dim stars. One thin streak crosses the
     space outside the disc every ~9 s at a shallow angle, glowing softly at the
     head, fading in and out. Its wire keeps an impact parameter of at least
     ~1.05r, so it skims the globe and never dives into the map, and the head
     travels the whole visible chord of the window — a crossing is never spent
     off screen. */
  function paintComets(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.80 + 0.20 * act;
    var WHEEL = 45, SLOTS = 5, STEP = WHEEL / SLOTS;
    var i, u1, u2, ang, dmax, rr, x, y, tw;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = IVORY;
    for (i = 0; i < 40; i++) {
      u1 = rnd(i, 907); u2 = rnd(i, 911);
      ang = u1 * TAU;
      dmax = edgeDist(cx, cy, W, H, ang);
      rr = r * 1.04 + Math.pow(u2, 1.3) * Math.max(0, dmax * 0.96 - r * 1.04);
      x = cx + Math.cos(ang) * rr;
      y = cy + Math.sin(ang) * rr;
      tw = 0.6 + 0.4 * Math.sin(t * (0.4 + u2) + u1 * 9.0);
      ctx.globalAlpha = (0.09 + 0.16 * rnd(i, 919)) * tw * gain;
      ctx.beginPath(); ctx.arc(x, y, 0.9 + 0.9 * u1, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    var wheel = t % WHEEL, pad = 26, sw;
    for (i = 0; i < SLOTS; i++) {
      var born = i * STEP + (i === 0 ? 0.75 + 0.15 * rnd(i, 929) : 0.40 + 1.60 * rnd(i, 929));
      var b = r * (1.05 + 0.30 * rnd(i, 937));
      var dirA = (rnd(i, 941) < 0.5 ? Math.PI : 0) + (rnd(i, 947) - 0.5) * 0.66;
      var dx = Math.cos(dirA), dy = Math.sin(dirA);
      var ax = cx - dy * b, ay = cy + dx * b;           /* the closest-approach point */
      var sA = -1e9, sB = 1e9, lo, hi;                  /* the wire, clipped to the window */
      if (Math.abs(dx) > 1e-6) {
        lo = (pad - ax) / dx; hi = (W - pad - ax) / dx;
        if (lo > hi) { sw = lo; lo = hi; hi = sw; }
        if (lo > sA) sA = lo;
        if (hi < sB) sB = hi;
      }
      if (Math.abs(dy) > 1e-6) {
        lo = (pad - ay) / dy; hi = (H - pad - ay) / dy;
        if (lo > hi) { sw = lo; lo = hi; hi = sw; }
        if (lo > sA) sA = lo;
        if (hi < sB) sB = hi;
      }
      if (sB <= sA + 40) continue;      /* only a sliver of a corner: not this slot */
      var span = clamp((sB - sA) / 380, 1.9, 2.8);
      var age = wheel - born;
      if (age < 0 || age > span) continue;
      var u = age / span;
      var fade = Math.sin(Math.PI * u);
      var s = sA - 40 + u * (sB - sA + 80);
      var hx = ax + dx * s, hy = ay + dy * s;
      var tl = 90 + 90 * rnd(i, 953);
      var tx = hx - dx * tl, ty = hy - dy * tl;
      var ca = clamp(0.38 * fade * gain, 0, 0.45);
      var g = ctx.createLinearGradient(hx, hy, tx, ty);
      g.addColorStop(0, rgba(IVORY, ca));
      g.addColorStop(0.30, rgba(CYAN, ca * 0.45));
      g.addColorStop(1, rgba(CYAN, 0));
      ctx.strokeStyle = g;
      ctx.lineCap = "round";
      ctx.lineWidth = 4.5;
      ctx.globalAlpha = 0.20;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
      var hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 9);
      hg.addColorStop(0, rgba(IVORY, clamp(0.42 * fade * gain, 0, 0.45)));
      hg.addColorStop(0.45, rgba(CYAN, 0.14 * fade));
      hg.addColorStop(1, rgba(CYAN, 0));
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(hx, hy, 9, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* ================================ 7 motes ===============================
     Slow soft dust, two depth layers at different speeds, drifting as if the
     room were very slightly in orbit. Bigger and blurrier than stars on purpose
     — these are the near things, out of focus — and they are never in a hurry. */
  function paintMotes(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.75 + 0.25 * act;
    var N = 24, i, layer, u1, u2, u3, u4, ang, dmax, dd, x, y, sz, a, wob, col;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < N; i++) {
      layer = i % 2;                                            /* even = near, odd = far */
      u1 = rnd(i, 401); u2 = rnd(i, 409); u3 = rnd(i, 419); u4 = rnd(i, 421);
      ang = u1 * TAU + t * (layer ? 0.009 : 0.022) * (u4 < 0.5 ? -1 : 1);
      dmax = edgeDist(cx, cy, W, H, ang);
      dd = r * 1.05 + Math.pow(u2, 1.2) * Math.max(0, dmax * 0.94 - r * 1.05);
      wob = layer ? 7 : 16;                                     /* the near layer floats wider */
      x = cx + Math.cos(ang) * dd + Math.sin(t * (layer ? 0.10 : 0.16) + u3 * 9.0) * wob;
      y = cy + Math.sin(ang) * dd + Math.cos(t * (layer ? 0.085 : 0.135) + u4 * 9.0) * wob;
      sz = layer ? (1.1 + 1.3 * u3) : (2.4 + 2.6 * u3);
      a = (layer ? 0.050 : 0.090) * (0.6 + 0.6 * u1) * gain;
      col = TINT[hash32(imul(i + 1, 0x7f4a7c15)) % TINT.length];
      ctx.fillStyle = col;
      ctx.globalAlpha = a * 0.28;               /* halo, body, core: a soft dot */
      ctx.beginPath(); ctx.arc(x, y, sz * 2.3, 0, TAU); ctx.fill();
      ctx.globalAlpha = a * 0.62;
      ctx.beginPath(); ctx.arc(x, y, sz * 1.25, 0, TAU); ctx.fill();
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(x, y, sz * 0.6, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* ================================ 8 pulse ===============================
     A breathing halo hugging the rim — the on-air aura, strongest while this
     window is the one playing — with a thin echo ring just inside it. Quiet by
     design: it should read as a lit rim, not as neon. */
  function paintPulse(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var breath = 0.72 + 0.28 * Math.sin(t * 1.35);
    var wob = 0.5 + 0.5 * Math.sin(t * 0.62 + 1.7);
    var a = (0.055 + 0.105 * act) * (0.55 + 0.45 * breath);
    var boom = r * (1.16 + 0.10 * wob), g, g2;
    ctx.globalCompositeOperation = "lighter";
    g = ctx.createRadialGradient(cx, cy, r * 1.005, cx, cy, boom);
    g.addColorStop(0, rgba(CYAN, a * 0.80));
    g.addColorStop(0.15, rgba(CYAN, a));
    g.addColorStop(0.55, rgba(CYAN, a * 0.24));
    g.addColorStop(1, rgba(CYAN, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - boom, cy - boom, boom * 2, boom * 2);
    g2 = ctx.createRadialGradient(cx, cy, r * 1.01, cx, cy, r * (1.22 + 0.10 * wob));
    g2.addColorStop(0, rgba(PINK, a * 0.30));
    g2.addColorStop(0.5, rgba(PINK, a * 0.10));
    g2.addColorStop(1, rgba(PINK, 0));
    ctx.fillStyle = g2;
    ctx.fillRect(cx - r * 1.5, cy - r * 1.5, r * 3, r * 3);
    ctx.strokeStyle = rgba(IVORY, clamp((0.025 + 0.065 * act) * (0.5 + 0.5 * breath), 0, 0.45));
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.035, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(CYAN, (0.03 + 0.075 * act) * (0.4 + 0.6 * breath));
    ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.058, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  /* ================================ 9 scan ================================
     Radar manners: two still rings, and one very faint sweep with a soft
     trailing wedge turning around the disc, a revolution every fourteen
     seconds. It reads as listening, not as detecting. */
  function paintScan(ctx, W, H, t, act, geo) {
    var cx = geo.cx, cy = geo.cy, r = geo.r;
    var gain = 0.80 + 0.20 * act;
    var sweep = (t / 14) * TAU;
    var Rmax = Math.sqrt(W * W + H * H) * 0.5 + r * 0.3;
    var steps = 30, span = 0.62, k, a0, a1, f, g;
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = rgba(CYAN, 0.055 * gain);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.2, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(PURPLE, 0.045 * gain);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, TAU); ctx.stroke();
    g = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, Rmax);
    g.addColorStop(0, rgba(CYAN, 0.048));
    g.addColorStop(0.35, rgba(CYAN, 0.028));
    g.addColorStop(1, rgba(CYAN, 0));
    ctx.fillStyle = g;
    /* the wedge is many overlapping slivers, not one shaped fan: the overlap
       is what turns the steps into a wash */
    for (k = 0; k < steps; k++) {
      a0 = sweep - span * (k + 1) / steps;
      a1 = sweep - span * k / steps * 0.72 + 0.004;
      f = 1 - k / steps;
      ctx.globalAlpha = f * f * gain;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, Rmax, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgba(CYAN, 0.16 * gain);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(sweep) * r * 0.90, cy + Math.sin(sweep) * r * 0.90);
    ctx.lineTo(cx + Math.cos(sweep) * Rmax, cy + Math.sin(sweep) * Rmax);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  /* =============================== 10 garden ==============================

     THE MOUSE-TRAIL LOOK — and the one deliberate exception to two of the laws
     at the top of this file.

     The state. Every other style here is a pure function of `tSec`; a trail
     cannot be, so this one keeps its own particle arrays in `G`. The page feeds
     it with GViz.ptr(x, y) — one call per pointermove, CSS px, viewport coords
     — and reads GViz.stats() for {flowers, doves} while the garden is the look
     being drawn (0/0 whenever it is not). Nothing else in this file keeps
     state; this block is the whole exception, and it is all here.

     The disc. The destination-out punch at the end of draw() belongs to the ten
     space looks: they dress the room AROUND the map and must never touch it. A
     garden cannot be built that way — the pointer walks over the disc, and
     blossoms that stopped at an invisible circle would look broken — so the
     punch is gated to styles 0-9 and the garden is painted after it. Blossoms
     ARE allowed over the disc. Deliberate, and still quiet: peaks near 0.5,
     settled near 0.16, never a wash.

     What grows. A blossom every ~26 px of pointer travel (wider asleep, tighter
     at full act) with a little jitter: a soft curved stem rising 10-16 px, 5-7
     rounded petal lobes around a small bright centre, tinted from ivory / lime /
     cyan most of the time, opening over 1.1 s, swaying on its own slow sine,
     fading out and dropped 26 s after it was born. 64 alive at most, oldest
     first out. Doves are ivory at ~0.35: a small curved body with two beating
     wings (~7 Hz), startled off when the pointer spikes past ~900 px/s or after
     every 6-11 s of steady movement, each flying a gentle 140-220 px arc away
     and upward over ~2.8 s.

     Even here nothing calls Math.random: every particle hashes its look out of a
     counter seed through rnd(), so two visitors tracing the same trail grow the
     same flowers.
     ======================================================================== */

  var G_LIFE = 10.0,                     /* a bloom's whole life, seconds */
      G_GROW = 1.1,                      /* seconds to open, ease-out */
      G_CAP = 64,                        /* blooms alive at once, oldest dropped */
      G_DOVES = 4;                       /* doves aloft at once */
  var G_PETAL = [IVORY, IVORY, IVORY, LIME, LIME, CYAN, CYAN, PINK, YELLOW];

  /* the garden's memory: built the first time anyone touches it, so a page
     that never looks at this style never pays for it */
  var G = null;
  function gst() {
    if (!G) {
      G = {
        on: false, reduced: false, act: 0.55, everOn: false,
        W: 0, H: 0,                                            /* last frame's size */
        n: 0, px: 0, py: 0, pm: 0,                             /* the latest pointer */
        wx: 0, wy: 0, wm: 0, wd: 0, wn: 0, speed: 0,           /* the ~130 ms speed window */
        cont: 0, dmNext: 9000,                                 /* steady-movement clock */
        trav: 0, fm: -1e9, seed: 0, dn: 0,                     /* the trail, and its seeds */
        doveMs: -1e9,                                          /* the last startle */
        flowers: [], doves: []
      };
    }
    return G;
  }
  function gnow() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  /* how far the pointer travels before the next blossom: the spec's curve
     (26 px at rest, ~20.8 px at full act), leaned further at idle so a sleeping
     page grows its garden slowly */
  function gSpacing(act) {
    var idle = clamp((0.55 - act) / 0.37, 0, 1);            /* 1 at 0.18, 0 from 0.55 up */
    return 26 * (1.35 - 0.55 * act) * (1 + 0.75 * idle);    /* ~57 px asleep */
  }

  /* one bloom's whole look, hashed out of its seed — same seed, same flower */
  function makeBloom(seed, x, y, born) {
    var s = seed | 0;
    return {
      seed: s, x: x, y: y, born: born,
      h: 10 + 6 * rnd(s, 1301),                     /* the stem: 10..16 px tall */
      lean: (rnd(s, 1307) - 0.5) * 1.6,             /* and which way it leans */
      lobes: 5 + ((rnd(s, 1319) * 3) | 0),          /* 5..7 petal lobes */
      ph: rnd(s, 1327) * TAU,                       /* sway phase */
      spin: (rnd(s, 1329) - 0.5) * 0.9,             /* how the rosette is turned */
      size: 0.80 + 0.40 * rnd(s, 1333),             /* head scale */
      tilt: (rnd(s, 1341) - 0.5) * 0.5,             /* head tilt */
      col: G_PETAL[(rnd(s, 1361) * G_PETAL.length) | 0]
    };
  }

  /* the blooms already standing when the look comes up: a gentle arc just
     outside the rim, hashed out of the seed, so a fresh visitor is never
     looking at a blank canvas. `born` is the caller's: the live garden hands
     them a little age, the reduced still hands them none. */
  function idleArc(W, H, geo, born) {
    var arr = [], nb = 4, i, u1, u2, k, ang, dd;
    for (i = 0; i < nb; i++) {
      u1 = rnd(i, 1409); u2 = rnd(i, 1423);
      k = (i - (nb - 1) / 2) / (nb - 1);                  /* -.5 .. .5 along the arc */
      ang = -2.45 + k * 0.62 + (u1 - 0.5) * 0.12;         /* an arc up and away */
      dd = geo.r * (1.09 + 0.10 * u2);
      arr.push(makeBloom(9000 + i,
        clamp(geo.cx + Math.cos(ang) * dd, 16, Math.max(16, W - 16)),
        clamp(geo.cy + Math.sin(ang) * dd, 32, Math.max(32, H - 12)), born));
    }
    return arr;
  }

  /* everything that has lived its life is dropped; called by draw() and by
     stats(), so the counts are always of things that are still there */
  function gPrune(st, now) {
    var i;
    for (i = st.flowers.length - 1; i >= 0; i--) {
      if (now - st.flowers[i].born > G_LIFE * 1000) st.flowers.splice(i, 1);
    }
    for (i = st.doves.length - 1; i >= 0; i--) {
      if (now - st.doves[i].born > st.doves[i].dur * 1000) st.doves.splice(i, 1);
    }
  }

  /* one dove taking off: aimed away from the stroke that startled it and leaned
     upward, on a gently bowed path, all of it hashed from its seed */
  function gDove(st, now, x, y, mvx, mvy) {
    var s = ++st.dn;
    var u1 = rnd(s, 1451), u2 = rnd(s, 1453), u3 = rnd(s, 1459), u4 = rnd(s, 1471);
    var dist = 140 + 80 * u1;                            /* 140..220 px of flight */
    var dir = Math.atan2(mvy, mvx);
    if (!isFinite(dir)) dir = -Math.PI / 2;
    dir += (u3 < 0.5 ? -1 : 1) * (0.30 + 0.70 * u4);     /* peeled off the stroke */
    var sx = x + (u1 - 0.5) * 12, sy = y - 6 - 10 * u2;
    var ex = clamp(sx + Math.cos(dir) * dist, 14, Math.max(14, st.W - 14));
    var ey = clamp(sy + Math.sin(dir) * dist - dist * (0.30 + 0.35 * u3),
                   18, Math.max(18, st.H - 18));         /* away, and upward-ish */
    var mx = (sx + ex) / 2 + Math.cos(dir + Math.PI / 2) * dist * (u4 - 0.5) * 0.40;
    var my = (sy + ey) / 2 + Math.sin(dir + Math.PI / 2) * dist * (u4 - 0.5) * 0.40
             - 10 - 12 * u2;
    st.doves.push({
      x0: sx, y0: sy, cx: mx, cy: my, x1: ex, y1: ey,
      dur: 2.4 + 0.8 * u2,                               /* 2.4..3.2 s */
      ph: rnd(s, 1477) * TAU,
      sc: 1.15 + 0.45 * rnd(s, 1481),
      born: now
    });
    if (st.doves.length > G_DOVES) st.doves.splice(0, st.doves.length - G_DOVES);
  }

  /* GViz.ptr(x, y) — the host's every pointermove, CSS px. The pointer is always
     stored; the trail only feeds while the garden is the live look, so every
     other style costs this file one boolean per event. */
  function gPtr(x, y) {
    if (!isFinite(x) || !isFinite(y)) return;
    var st = gst(), now = gnow();
    var first = st.n === 0;
    var dx = first ? 0 : x - st.px, dy = first ? 0 : y - st.py;
    var d = Math.sqrt(dx * dx + dy * dy);
    var dt = first ? 0 : Math.max(0, now - st.pm);
    st.n++; st.px = x; st.py = y; st.pm = now;
    if (!st.on || st.reduced) return;

    /* speed: what the pointer covered over the last ~130 ms, never one event */
    if (st.wm === 0 || now - st.wm > 130) { st.wx = x; st.wy = y; st.wm = now; st.wd = 0; st.wn = 0; }
    else { st.wd += d; st.wn++; }
    var wdt = (now - st.wm) / 1000;
    if (st.wn >= 3 && wdt > 0.02) st.speed = st.wd / wdt;
    else if (dt > 400) st.speed = 0;                      /* a pause cools it */

    /* the trail */
    st.trav += d;
    if (st.trav >= gSpacing(st.act) && now - st.fm >= 90) {
      st.fm = now; st.trav = 0; st.seed++;
      st.flowers.push(makeBloom(st.seed,
        x + (rnd(st.seed, 1373) * 2 - 1) * 10,            /* +-10 px of jitter */
        y + (rnd(st.seed, 1379) * 2 - 1) * 10, now));
      if (st.flowers.length > G_CAP) st.flowers.splice(0, st.flowers.length - G_CAP);
    }

    /* doves: a hard flick startles one off; a long steady stroke wakes one */
    if (dt > 400) st.cont = 0; else st.cont += dt;
    var spike = 900 * (st.act < 0.35 ? 1.6 : 1.0);        /* asleep: only strong spikes */
    var cool = st.act > 0.75 ? 2500 : 3500;               /* playing: 2.5 s, else 3.5 s */
    if (st.doves.length < G_DOVES && st.speed >= spike && now - st.doveMs >= cool) {
      st.doveMs = now;
      gDove(st, now, x, y, dx, dy);
    } else if (st.act >= 0.35 && st.doves.length < G_DOVES && st.cont >= st.dmNext) {
      st.dmNext = 6000 + 5000 * rnd(++st.dn, 1483);       /* 6..11 s of movement */
      st.cont = 0;
      gDove(st, now, x, y, dx, dy);
    }
  }

  /* one blossom, read off the clock: opens over ~1.1 s (ease-out), stands and
     sways, wears down from its 0.5 peak towards ~0.16 as it settles, and is
     gone 26 s after it was born. The stem carries the head; the head is a
     rosette of rounded lobes around a small bright centre. */
  function drawBloom(ctx, f, age, ts, gain) {
    var u = clamp(age / G_GROW, 0, 1);
    var grow = 1 - (1 - u) * (1 - u) * (1 - u);           /* ease-out */
    if (grow < 0.03) return;
    var settle = Math.pow(0.5, Math.max(0, age - 1.6) / 2.2);
    var a = 0.5 * grow * (0.32 + 0.68 * settle) * gain
          * smooth(clamp((G_LIFE - age) / 3.2, 0, 1));    /* and the last breath */
    if (a < 0.005) return;
    var sway = Math.sin(ts * 0.6 + f.ph) * (0.5 + 0.5 * grow);
    var hh = f.h * grow;
    var hx = f.x + f.lean * hh * 0.42 + sway * 1.8;
    var hy = f.y - hh + sway * 0.4;
    var R = 5.0 * f.size * (0.32 + 0.68 * grow);
    var L = R * 1.02, w = R * 0.52, k;
    /* the stem */
    ctx.strokeStyle = rgba(LIME, a * 0.45);
    ctx.lineWidth = 1.15;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.quadraticCurveTo(f.x + f.lean * hh * 0.70, f.y - hh * 0.60, hx, hy);
    ctx.stroke();
    /* the head: a soft halo, then a rosette of fat rounded lobes — one path,
       one fill — and then the same rosette half a size down in ivory. That
       pale heart is what makes the head read as a blossom and not as a star. */
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(f.tilt + sway * 0.18);
    ctx.fillStyle = rgba(f.col, a * 0.06);
    ctx.beginPath(); ctx.arc(0, 0, R * 1.18, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(f.col, a * 0.44);
    ctx.beginPath();
    for (k = 0; k < f.lobes; k++) {
      ctx.save();
      ctx.rotate(f.spin + k * TAU / f.lobes);
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(L * 0.34, -w * 1.18, L * 0.80, -w * 1.05, L, 0);
      ctx.bezierCurveTo(L * 0.80, w * 1.05, L * 0.34, w * 1.18, 0, 0);
      ctx.closePath();
      ctx.restore();
    }
    ctx.fill();
    ctx.fillStyle = rgba(IVORY, a * 0.30);
    ctx.beginPath();
    for (k = 0; k < f.lobes; k++) {
      ctx.save();
      ctx.rotate(f.spin + (k + 0.5) * TAU / f.lobes);
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(L * 0.19, -w * 0.60, L * 0.44, -w * 0.54, L * 0.53, 0);
      ctx.bezierCurveTo(L * 0.44, w * 0.54, L * 0.19, w * 0.60, 0, 0);
      ctx.closePath();
      ctx.restore();
    }
    ctx.fill();
    ctx.fillStyle = rgba(IVORY, a * 0.58);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.22, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /* one dove: a small curved body with two wings caught mid-beat (~7 Hz), ivory
     and barely there, fading in as it climbs away and out before it lands. The
     path is a bowed quadratic with a slight bob riding on top of it. */
  function drawDove(ctx, d, age, gain) {
    var u = age / d.dur, q = 1 - u;
    var fade = smooth(u / 0.16) * (1 - smooth((u - 0.70) / 0.30));
    var a = 0.35 * fade * gain;
    if (a < 0.005) return;
    var x = q * q * d.x0 + 2 * q * u * d.cx + u * u * d.x1;
    var y = q * q * d.y0 + 2 * q * u * d.cy + u * u * d.y1 + Math.sin(u * 7.4 + d.ph) * 1.7;
    var head = Math.atan2(2 * (q * (d.cy - d.y0) + u * (d.y1 - d.cy)),
                          2 * (q * (d.cx - d.x0) + u * (d.x1 - d.cx)));
    var flap = Math.sin(age * TAU * 7 + d.ph);            /* the beat: ~7 Hz */
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(head);
    ctx.scale(d.sc, d.sc);
    /* the near wing: swept back and up on this half of the beat */
    ctx.fillStyle = rgba(IVORY, a * 0.85);
    ctx.beginPath();
    ctx.moveTo(1.0, -0.5);
    ctx.quadraticCurveTo(0.2, -2.0 - 1.6 * flap, -2.3, -1.5 - 5.2 * flap);
    ctx.quadraticCurveTo(-0.7, 0.3 - 0.9 * flap, -0.1, 0.4);
    ctx.closePath();
    ctx.fill();
    /* the far wing: the other half of the beat, further back and dimmer */
    ctx.fillStyle = rgba(IVORY, a * 0.42);
    ctx.beginPath();
    ctx.moveTo(0.6, -0.9);
    ctx.quadraticCurveTo(-0.2, -1.5 + 1.3 * flap, -3.0, -0.3 + 4.6 * flap);
    ctx.quadraticCurveTo(-1.2, -0.7 + 0.6 * flap, -0.4, -1.0);
    ctx.closePath();
    ctx.fill();
    /* the body: beak, crown, back, tail, belly — a small soft lens with a head */
    ctx.fillStyle = rgba(IVORY, a);
    ctx.beginPath();
    ctx.moveTo(3.7, -0.7);
    ctx.quadraticCurveTo(2.5, -1.7, 1.2, -1.6);
    ctx.quadraticCurveTo(-1.2, -1.6, -3.2, -0.9);
    ctx.quadraticCurveTo(-4.6, -0.4, -5.3, 0.5);
    ctx.quadraticCurveTo(-3.4, 0.9, -0.6, 1.0);
    ctx.quadraticCurveTo(2.1, 1.1, 3.7, -0.7);
    ctx.fill();
    ctx.restore();
  }

  function paintGarden(ctx, W, H, t, act, reduced, geo) {
    var st, i, j, now, ts, gain, idle;
    if (reduced) {
      /* a composed still, not an empty canvas: the idle cluster standing, no
         growth, no clock, no doves — two paints of it are the same painting */
      idle = idleArc(W, H, geo, 0);
      ctx.globalCompositeOperation = "lighter";
      for (i = 0; i < idle.length; i++) drawBloom(ctx, idle[i], 3.6, t, 0.9 + 0.1 * act);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    st = gst();
    st.act = act; st.on = true; st.reduced = false; st.W = W; st.H = H;
    now = gnow(); ts = now / 1000;
    if (!st.everOn || !st.flowers.length) {
      /* activation — and any later moment the garden has gone quiet: there is
         always something standing when the look comes up, a little older as the
         arc runs on, so the cluster has depth instead of a row of dots */
      st.everOn = true;
      idle = idleArc(W, H, geo, 0);
      for (j = 0; j < idle.length; j++) {
        idle[j].born = now - (800 + 900 * j + 300 * rnd(j, 1493));
        st.flowers.push(idle[j]);
      }
    }
    gPrune(st, now);
    gain = 0.9 + 0.1 * act;
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < st.flowers.length; i++) {
      drawBloom(ctx, st.flowers[i], (now - st.flowers[i].born) / 1000, ts, gain);
    }
    for (i = 0; i < st.doves.length; i++) {
      drawDove(ctx, st.doves[i], (now - st.doves[i].born) / 1000, gain);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /* the look changed away from the garden: park it. ptr() still stores the
     pointer, the trail stops feeding, and the counts fall back to 0/0 as the
     contract says they must. */
  function gardenOff() {
    if (!G || !G.on) return;
    G.on = false; G.reduced = false;
    G.flowers.length = 0; G.doves.length = 0;
    G.trav = 0; G.cont = 0; G.n = 0; G.speed = 0;
  }

  /* GViz.stats(): how much of the garden is alive right now */
  function gStats() {
    if (!G || !G.on) return { flowers: 0, doves: 0 };
    gPrune(G, gnow());
    return { flowers: G.flowers.length, doves: G.doves.length };
  }

  /* ================================= frame ================================= */
  function draw(ctx, W, H, style, tSec, act, reduced, geo) {
    ctx.clearRect(0, 0, W, H);

    var s = (style | 0) % STYLES.length;
    if (s < 0) s += STYLES.length;
    var t = isFinite(tSec) ? +tSec : 0;
    var a = clamp(isFinite(act) ? +act : 0, 0, 1);
    var g = geo && geo.r > 0 ? geo : { cx: W / 2, cy: H / 2, r: 0.425 * Math.min(W, H) };
    if (reduced) t = R_POSE[s];                                 /* one composed still */

    if (s !== 10) gardenOff();        /* the garden is parked while other looks draw */

    ctx.save();
    if (s === 0) paintStars(ctx, W, H, t, a, g);
    else if (s === 1) paintNebula(ctx, W, H, t, a, g);
    else if (s === 2) paintAurora(ctx, W, H, t, a, g);
    else if (s === 3) paintOrbits(ctx, W, H, t, a, g);
    else if (s === 4) paintConstellations(ctx, W, H, t, a, g);
    else if (s === 5) paintRipples(ctx, W, H, t, a, g);
    else if (s === 6) paintComets(ctx, W, H, t, a, g);
    else if (s === 7) paintMotes(ctx, W, H, t, a, g);
    else if (s === 8) paintPulse(ctx, W, H, t, a, g);
    else if (s === 9) paintScan(ctx, W, H, t, a, g);
    ctx.restore();

    /* THE DISC LAW, the hard half: erase everything the look painted inside the
       disc, and let the last few pixels outside it feather off, so the globe
       keeps its map and the room keeps its weather. Nothing is painted after
       this, so the alpha over the disc is exactly zero. Styles 0-9 ONLY: style
       10 "garden" is the one deliberate exception, and paints after the punch
       (blossoms are allowed over the disc — see the 10 garden block above). */
    if (s < 10) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      var hole = ctx.createRadialGradient(g.cx, g.cy, g.r, g.cx, g.cy, g.r * 1.022);
      hole.addColorStop(0, "rgba(0,0,0,1)");
      hole.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = hole;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* 10 garden — the mouse trail, painted last and over everything: it is the
       look that lives over the disc as well as outside it. */
    if (s === 10) {
      ctx.save();
      paintGarden(ctx, W, H, t, a, reduced, g);
      ctx.restore();
    }

    ctx.globalAlpha = 1;                                        /* leave it as we found it */
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
  }

  return { STYLES: STYLES, draw: draw, ptr: gPtr, stats: gStats };
})();
