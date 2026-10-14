/* ============================================================================
   GlobeView — the World View engine for MODDYS World Radio.

   One canvas, no dependencies beyond the vendored WORLDGEO bundle (d3-geo subset
   + land-110m geometry). It draws an orthographic "hologram" globe in the site's
   palette: space backdrop, neon graticule + land, the live day/night terminator,
   and one dot (or cluster bubble) per geocoded station — drag to rotate, wheel or
   pinch to zoom, inertia, gentle idle spin, hover pick, click pick, fly-to.

   The host page owns the data and the player; this engine owns pixels and input:

       GlobeView.mount(canvas, {onSelect, onHover, onView}) -> true|false
       GlobeView.setPoints([{i, la, lo, cu, pk, st, cc}, ...])   // filtered set
       GlobeView.setLabels([{name, n, la, lo}, ...])             // country tier
       GlobeView.setNow(stationIndex | null)                     // now-playing marker
       GlobeView.setTerminator(bool) / setSpin(bool) / setActive(bool)
       GlobeView.flyTo(lon, lat, zoom, ms, done) / jump(lon,lat,zoom)
       GlobeView.zoomBy(k) / nudge(dLon, dLat) / center()
       GlobeView.state() -> probe object for tests and the HUD
       GlobeView.hitAt(x, y) -> cluster payload | null   (canvas-local CSS px)
       GlobeView.pointAt(x, y) -> [lon, lat] | null
   ============================================================================ */
window.GlobeView = (function () {
  "use strict";

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  var cv = null, ctx = null, W = 0, H = 0, dpr = 1;
  var mounted = false, active = true, raf = 0, frames = 0, lastT = 0, dtEma = 16;
  var GRAT = null;

  /* camera: the globe centre, in degrees */
  var lon = 10, lat = 24, zoom = 1;
  var spin = !REDUCED, terminator = true;
  var hovered = null, nowIdx = null, nowGeo = null;
  var vLon = 0, vLat = 0, dragging = false, movedPx = 0, lastX = 0, lastY = 0, downT = 0;
  var pointers = new Map();
  var pinchD0 = 0, pinchZ0 = 1;
  var fly = null, ping = null;
  var mx = -1, my = -1, hoverCheck = 0;
  var stars = null;
  var quality = 1;
  var termCache = { t: 0, lon: 0, lat: 0 };
  var lastView = 0, lastViewSent = {};
  var qFrames = 0;

  var pts = [], idxToPt = new Map(), clusters = [], labels = [], tier = -1;
  var proj = null, projR = 0, projCx = 0, projCy = 0;
  var cb = { select: null, hover: null, view: null };

  var TIERS = [1, 1.45, 2, 2.8, 3.9, 5.4, 7.5, 10.5, 14.5, 20, 28, 40];

  function rad(d) { return d * D2R; }
  function norm(l) { l = l % 360; if (l > 180) l -= 360; if (l < -180) l += 360; return l; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function cosd(d) { return Math.cos(rad(d)); }
  function sind(d) { return Math.sin(rad(d)); }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /* ---------------- canvas sizing + the deterministic starfield ---------------- */
  function dprCap() { return Math.min(window.devicePixelRatio || 1, quality < 0.75 ? 1 : 1.5); }
  function resize() {
    if (!cv) return;
    var w = cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 600;
    var h = cv.clientHeight || 420;
    if (!w || !h) return;                          // still hidden; the host calls setActive(true) on show
    dpr = dprCap(); W = w; H = h;
    cv.width = Math.max(2, Math.round(w * dpr));
    cv.height = Math.max(2, Math.round(h * dpr));
    buildStars();
    tier = -1;
    draw();
  }
  function buildStars() {
    var n = quality < 0.75 ? 160 : 330;
    stars = document.createElement("canvas");
    stars.width = Math.max(2, Math.round(W * dpr));
    stars.height = Math.max(2, Math.round(H * dpr));
    var c = stars.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var rnd = mulberry(0x51ACE);
    for (var i = 0; i < n; i++) {
      c.globalAlpha = 0.10 + rnd() * 0.5;
      c.fillStyle = (i % 9 === 0) ? "#9be9ff" : "#cfd8ff";
      c.beginPath(); c.arc(rnd() * W, rnd() * H, 0.3 + rnd() * 1.1, 0, 6.2832); c.fill();
    }
    c.globalAlpha = 1;
  }

  /* ---------------- data ---------------- */
  function setPoints(list) {
    pts = [];
    var src = list || [];
    for (var i = 0; i < src.length; i++) {
      var p = src[i], la = +p.la, lo = +p.lo;
      if (!isFinite(la) || !isFinite(lo)) continue;
      pts.push({ i: p.i | 0, la: la, lo: lo, cu: !!p.cu, pk: !!p.pk, st: p.st || "", cc: p.cc || "",
                 cl: cosd(lo), sl: sind(lo), mu: cosd(la), nu: sind(la) });
    }
    idxToPt = new Map();
    for (var j = 0; j < pts.length; j++) idxToPt.set(pts[j].i, pts[j]);
    tier = -1;
  }
  function setLabels(list) {
    labels = [];
    var src = list || [];
    for (var i = 0; i < src.length; i++) {
      var l = src[i], la = +l.la, lo = +l.lo;
      if (!isFinite(la) || !isFinite(lo)) continue;
      labels.push({ name: String(l.name || ""), n: l.n | 0, la: la, lo: lo,
                    cl: cosd(lo), sl: sind(lo), mu: cosd(la), nu: sind(la) });
    }
  }
  function setNow(i, la, lo) {
    nowIdx = (i == null) ? null : (i | 0);
    nowGeo = (isFinite(la) && isFinite(lo))
      ? { la: +la, lo: +lo, cl: cosd(+lo), sl: sind(+lo), mu: cosd(+la), nu: sind(+la) } : null;
  }

  /* ---------------- clustering: one consumer-facing bubble per grid cell ---------------- */
  function tierOf(z) { for (var k = 0; k < TIERS.length; k++) if (z <= TIERS[k] * 1.06) return k; return TIERS.length - 1; }
  function buildClusters() {
    var t = tierOf(zoom); tier = t;
    if (!pts.length) { clusters = []; return; }
    var R0 = Math.min(W, H) * 0.42;
    var k = R0 * TIERS[Math.min(t, TIERS.length - 1)];
    var cell = clamp(2400 / Math.max(60, k), 0.05, 30);        // degrees per cell (≈43 px bubbles)
    var map = new Map(), n, p, key, c;
    for (n = 0; n < pts.length; n++) {
      p = pts[n];
      key = Math.floor((p.la + 90) / cell) * 100000 + Math.floor((p.lo + 180) / cell);
      c = map.get(key);
      if (!c) { c = { n: 0, x: 0, y: 0, z: 0, cu: false, idxs: [], top: new Map(), cc: new Map() }; map.set(key, c); }
      c.n++;
      if (c.idxs.length < 48) {
        c.idxs.push(p.i);
        if (p.st) c.top.set(p.st, (c.top.get(p.st) || 0) + 1);
        if (p.cc) c.cc.set(p.cc, (c.cc.get(p.cc) || 0) + 1);
      }
      c.cu = c.cu || p.cu;
      c.x += p.mu * p.cl; c.y += p.mu * p.sl; c.z += p.nu;
    }
    clusters = [];
    map.forEach(function (cl) {
      var x = cl.x / cl.n, y = cl.y / cl.n, z = cl.z / cl.n;
      var m = Math.sqrt(x * x + y * y + z * z) || 1;
      var cLa = Math.asin(clamp(z / m, -1, 1)) * R2D, cLo = Math.atan2(y, x) * R2D;
      var best = "", bn = 0; cl.top.forEach(function (v, kk) { if (v > bn) { bn = v; best = kk; } });
      var bcc = "", bcn = 0; cl.cc.forEach(function (v, kk) { if (v > bcn) { bcn = v; bcc = kk; } });
      clusters.push({ n: cl.n, idxs: cl.idxs, cu: cl.cu, la: cLa, lo: cLo, label: best || bcc || "",
                      ccx: bcc, cl: cosd(cLo), sl: sind(cLo), mu: cosd(cLa), nu: sind(cLa),
                      _vis: false, _x: 0, _y: 0, _r: 0, _z: 0 });
    });
    clusters.sort(function (a, b) { return a.n - b.n; });      // small first, big drawn on top
  }

  /* ---------------- the live terminator ---------------- */
  function subsolar(d) {
    var jd = d.getTime() / 86400000 + 2440587.5;
    var n = jd - 2451545.0;
    var L = 280.460 + 0.9856474 * n;
    var g = rad((357.528 + 0.9856003 * n) % 360);
    var lam = rad((L % 360) + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    var eps = rad(23.439 - 0.0000004 * n);
    var decl = Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D;
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D;
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    if (gmst < 0) gmst += 24;
    return [norm(ra - gmst * 15), decl];
  }

  /* ---------------- drawing ---------------- */
  function ease(u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }

  function draw() {
    if (!ctx || !cv || !active || !W || !H) return;
    var g = window.WORLDGEO;
    if (!g) return;
    var now = performance.now();
    var dt = Math.min(90, now - (lastT || now)); lastT = now;
    dtEma = dtEma * 0.9 + dt * 0.1;
    frames++;

    /* auto-quality: pull dpr and the draw cap down on slow frames, restore slowly */
    if (++qFrames > 120) {
      qFrames = 0;
      if (dtEma > 40 && quality > 0.6) { quality = Math.max(0.6, quality - 0.2); resize(); }
      else if (dtEma < 21 && quality < 1) { quality = Math.min(1, quality + 0.1); }
    }

    /* motion: fly-to, inertia, idle spin */
    if (fly) {
      var u = clamp((now - fly.t0) / fly.ms, 0, 1), e = ease(u);
      lon = norm(fly.lon0 + fly.dlon * e);
      lat = fly.lat0 + (fly.lat1 - fly.lat0) * e;
      zoom = fly.zoom0 + (fly.zoom1 - fly.zoom0) * e;
      if (u >= 1) { var done = fly.done; ping = { la: fly.lat1, lo: fly.lon1, t0: now }; fly = null; if (done) done(); }
    } else if (!dragging) {
      lon = norm(lon + vLon); lat = clamp(lat + vLat, -88, 88);
      vLon *= 0.93; vLat *= 0.93;
      if (Math.abs(vLon) < 0.002) vLon = 0;
      if (Math.abs(vLat) < 0.002) vLat = 0;
      /* the spin holds still while the pointer is anywhere on the globe - not only over a dot.
         A user reported the globe "drifting" with their cursor resting on empty ocean: the old
         rule only paused when a cluster was within reach, so the drift kept running. */
      var pointerOn = mx >= 0 && mx <= W && my >= 0 && my <= H;
      if (spin && !REDUCED && !hovered && !pointerOn) lon = norm(lon + 2.2 * (dt / 1000));
    }
    lon = norm(lon);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stars) ctx.drawImage(stars, 0, 0, W, H);

    var R0 = Math.min(W, H) * 0.42, cx = W / 2, cy = H / 2;
    var R = R0 * zoom;
    if (tierOf(zoom) !== tier) buildClusters();

    proj = g.geoOrthographic().rotate([-lon, -lat]).scale(R).translate([cx, cy]).clipAngle(90);
    projR = R; projCx = cx; projCy = cy;
    var path = g.geoPath(proj, ctx);

    /* the sphere itself: deep glass with a rim */
    var grad = ctx.createRadialGradient(cx, cy, R * 0.12, cx, cy, R);
    grad.addColorStop(0, "rgba(17,24,46,.94)");
    grad.addColorStop(0.68, "rgba(11,15,32,.94)");
    grad.addColorStop(1, "rgba(7,10,24,.96)");
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.strokeStyle = "rgba(31,227,255,.55)"; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R + 2, 0, 6.2832); ctx.strokeStyle = "rgba(31,227,255,.26)"; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, 6.2832); ctx.strokeStyle = "rgba(31,227,255,.09)"; ctx.lineWidth = 8; ctx.stroke();

    /* graticule, then land — the hologram lines */
    if (GRAT) { ctx.beginPath(); path(GRAT); ctx.strokeStyle = "rgba(148,163,203,.15)"; ctx.lineWidth = 0.75; ctx.stroke(); }
    ctx.beginPath(); path(g.land);
    ctx.fillStyle = "rgba(34,92,128,.62)"; ctx.fill();
    ctx.strokeStyle = "rgba(31,227,255,.42)"; ctx.lineWidth = 0.9; ctx.stroke();

    /* the night side, leaning on the real sun position */
    if (terminator) {
      if (now - termCache.t > 30000) { var sub = subsolar(new Date()); termCache = { t: now, lon: sub[0], lat: sub[1] }; }
      var night = g.geoCircle().center([norm(termCache.lon + 180), -termCache.lat]).radius(90)();
      ctx.beginPath(); path(night); ctx.fillStyle = "rgba(4,7,20,.46)"; ctx.fill();
    }

    /* project + draw the dots (small first, big last) */
    var c0 = cosd(lon), s0 = sind(lon), cf = cosd(lat), sf = sind(lat);
    var cap = quality < 0.7 ? 700 : quality < 0.9 ? 1100 : 1600;
    var list = clusters.length > cap ? clusters.slice(clusters.length - cap) : clusters;
    var kk, cl2;
    for (kk = 0; kk < clusters.length; kk++) { cl2 = clusters[kk]; cl2._vis = false; }
    for (kk = 0; kk < list.length; kk++) {
      cl2 = list[kk];
      var dl = cl2.sl * c0 - cl2.cl * s0, dc = cl2.cl * c0 + cl2.sl * s0;
      var z = sf * cl2.nu + cf * cl2.mu * dc;
      if (z <= 0.001) continue;
      var x3 = cl2.mu * dl, y3 = cf * cl2.nu - sf * cl2.mu * dc;
      cl2._x = cx + R * x3; cl2._y = cy - R * y3; cl2._z = z;
      cl2._r = cl2.n === 1 ? 3.2 : Math.min(zoom < 1.6 ? 12 : 17, 2.1 + 2.05 * Math.sqrt(cl2.n));
      cl2._vis = true;
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.clip();
    for (kk = 0; kk < list.length; kk++) {
      cl2 = list[kk];
      if (!cl2._vis) continue;
      var rr = cl2._r;
      if (cl2.n === 1) {
        var single = idxToPt.get(cl2.idxs[0]);
        var isHov = hovered === cl2;
        /* the soft halo, so an individual station reads before the pointer is on it */
        if (single && (single.pk || single.cu)) {
          ctx.beginPath(); ctx.arc(cl2._x, cl2._y, rr + (isHov ? 4.5 : 3), 0, 6.2832);
          ctx.fillStyle = single.cu ? "rgba(201,255,61," + (isHov ? 0.5 : 0.28) + ")"
                                    : "rgba(31,227,255," + (isHov ? 0.5 : 0.28) + ")";
          ctx.fill();
        }
        ctx.beginPath(); ctx.arc(cl2._x, cl2._y, isHov ? rr + 2 : rr, 0, 6.2832);
        if (isHov) { ctx.fillStyle = "#ffe14d"; ctx.fill(); }
        else if (single && single.cu) { ctx.fillStyle = "#c9ff3d"; ctx.fill(); }
        else if (single && single.pk) { ctx.fillStyle = "#1fe3ff"; ctx.fill(); }
        else { ctx.strokeStyle = "rgba(190,200,225,.9)"; ctx.lineWidth = 1.2; ctx.stroke(); }
      } else {
        var isH2 = hovered === cl2;
        ctx.beginPath(); ctx.arc(cl2._x, cl2._y, rr, 0, 6.2832);
        ctx.fillStyle = cl2.cu ? "rgba(201,255,61,.16)" : "rgba(31,227,255,.15)";
        ctx.fill();
        ctx.strokeStyle = isH2 ? "#ffe14d" : (cl2.cu ? "rgba(201,255,61,.85)" : "rgba(31,227,255,.8)");
        ctx.lineWidth = isH2 ? 2 : 1.2;
        ctx.stroke();
        if (rr >= 7.5 && cl2.n >= 3) {
          ctx.fillStyle = "#dffaff";
          ctx.font = "700 10px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(cl2.n), cl2._x, cl2._y + 0.5);
        }
      }
    }

    /* now-playing marker: a lime pulse that rides the dot */
    if (nowIdx != null) {
      var np = idxToPt.get(nowIdx) || nowGeo;
      if (np) {
        var ndl = np.sl * c0 - np.cl * s0, ndc = np.cl * c0 + np.sl * s0;
        var nz = sf * np.nu + cf * np.mu * ndc;
        if (nz > 0.001) {
          var nx = cx + R * np.mu * ndl, ny = cy - R * (cf * np.nu - sf * np.mu * ndc);
          var pulse = 0.5 + 0.5 * Math.sin(now / 320);
          ctx.beginPath(); ctx.arc(nx, ny, 6 + pulse * 4.5, 0, 6.2832);
          ctx.strokeStyle = "rgba(201,255,61," + (0.35 + 0.55 * (1 - pulse)) + ")";
          ctx.lineWidth = 1.8; ctx.stroke();
          ctx.beginPath(); ctx.arc(nx, ny, 2.6, 0, 6.2832);
          ctx.fillStyle = "#eaffb8"; ctx.fill();
          ctx.strokeStyle = "#c9ff3d"; ctx.lineWidth = 1; ctx.stroke();
        }
      }
    }
    /* arrival ping after a flight */
    if (ping) {
      var age = now - ping.t0;
      if (age >= 900) ping = null;
      else {
        var pj = proj([ping.lo, ping.la]);
        if (pj) {
          var pr = 5 + age * 0.045;
          ctx.beginPath(); ctx.arc(pj[0], pj[1], pr, 0, 6.2832);
          ctx.strokeStyle = "rgba(31,227,255," + (0.6 * (1 - age / 900)) + ")";
          ctx.lineWidth = 1.6; ctx.stroke();
        }
      }
    }

    ctx.restore();
    /* place labels: country tier when the whole globe fits, cluster seats beyond */
    drawLabels(now, cx, cy, R, c0, s0, cf, sf);

    /* hover: recompute under the pointer a few times a second */
    if (mx >= 0 && mx <= W && my >= 0 && my <= H && now - hoverCheck > 90) {
      hoverCheck = now;
      var h = findAt(mx, my);
      if (h !== hovered) { hovered = h; if (cb.hover) cb.hover(h ? payload(h) : null); }
      cv.style.cursor = dragging ? "grabbing" : (h ? "pointer" : "grab");
    }

    /* the view read-out (throttled) */
    if (cb.view && now - lastView > 140) {
      lastView = now;
      var vs = { lon: r2(lon), lat: r2(lat), zoom: r2(zoom) };
      if (vs.lon !== lastViewSent.lon || vs.lat !== lastViewSent.lat || vs.zoom !== lastViewSent.zoom) {
        lastViewSent = vs; cb.view(vs);
      }
    }
  }

  function drawLabels(now, cx, cy, R, c0, s0, cf, sf) {
    var placed = [], k, obj, dl, dc, z, x, y, alpha, txt;
    ctx.font = "600 10.5px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (zoom < 1.9 && labels.length) {
      for (k = 0; k < labels.length; k++) {
        obj = labels[k];
        dl = obj.sl * c0 - obj.cl * s0; dc = obj.cl * c0 + obj.sl * s0;
        z = sf * obj.nu + cf * obj.mu * dc;
        if (z <= 0.08) continue;
        x = cx + R * obj.mu * dl; y = cy - R * (cf * obj.nu - sf * obj.mu * dc);
        alpha = clamp(z * 2.6, 0, 0.95);
        txt = obj.name + (obj.n > 1 ? " · " + obj.n : "");
        if (putLabel(placed, txt, x, y, alpha)) { /* drawn */ }
      }
    } else {
      var shown = 0;
      for (k = clusters.length - 1; k >= 0 && shown < 24; k--) {
        obj = clusters[k];
        if (!obj._vis || obj._r < 8 || obj.n < 3 || !obj.label) continue;
        txt = obj.label + " · " + obj.n;
        alpha = clamp(obj._z * 2.4, 0, 0.9);
        if (putLabel(placed, txt, obj._x, obj._y - obj._r - 6, alpha)) shown++;
      }
    }
  }

  function putLabel(placed, txt, x, y, alpha) {
    var w = ctx.measureText(txt).width;
    var box = { x: x - w / 2 - 3, y: y - 7, w: w + 6, h: 14 };
    for (var i = 0; i < placed.length; i++) {
      var b = placed[i];
      if (box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y) return false;
    }
    placed.push(box);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = "rgba(0,0,0,.75)"; ctx.shadowBlur = 3;
    ctx.fillStyle = "#d9f4ff";
    ctx.fillText(txt, x, y);
    ctx.restore();
    return true;
  }

  /* ---------------- picking ---------------- */
  function findAt(x, y) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < clusters.length; i++) {
      var c = clusters[i];
      if (!c._vis) continue;
      var dx = c._x - x, dy = c._y - y;
      var d2 = dx * dx + dy * dy;
      var lim = Math.max(12, c._r + 6);   /* a finger's-width reach for the small "final dots" */
      if (d2 <= lim * lim && d2 < bestD) { bestD = d2; best = c; }
    }
    return best;
  }
  function payload(c) {
    return { label: c.label, n: c.n, cu: c.cu, idxs: c.idxs, la: r2(c.la), lo: r2(c.lo), x: r2(c._x), y: r2(c._y), r: r2(c._r) };
  }

  /* ---------------- loop ---------------- */
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!active || document.hidden) return;
    draw();
  }

  /* ---------------- input ---------------- */
  function localXY(e) {
    var r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }
  function onDown(e) {
    if (e.button != null && e.button !== 0 && e.pointerType === "mouse") return;
    if (fly) fly = null;
    var p = localXY(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      var it = Array.from(pointers.values());
      pinchD0 = Math.max(1, Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y));
      pinchZ0 = zoom;
    }
    dragging = true; movedPx = 0; lastX = p.x; lastY = p.y; downT = performance.now();
    mx = p.x; my = p.y;
    vLon = 0; vLat = 0;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    cv.style.cursor = "grabbing";
  }
  function onMove(e) {
    if (!cv) return;
    var p = localXY(e);
    if (e.pointerType === "mouse" || e.pointerType == null) { mx = p.x; my = p.y; }
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, p);
      if (pointers.size === 2 && pinchD0 > 0) {
        var it = Array.from(pointers.values());
        var d = Math.max(1, Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y));
        zoom = clamp(pinchZ0 * (d / pinchD0), 1, 40);
        return;
      }
      if (dragging) {
        var dx = p.x - lastX, dy = p.y - lastY;
        movedPx += Math.abs(dx) + Math.abs(dy);
        var R = Math.min(W, H) * 0.42 * zoom;
        var sens = 57.2958 / Math.max(40, R);
        lon = norm(lon - dx * sens);
        lat = clamp(lat + dy * sens, -88, 88);
        vLon = -dx * sens * 0.5; vLat = dy * sens * 0.5;
        lastX = p.x; lastY = p.y;
      }
    } else if (mx >= 0 && (p.x < -30 || p.y < -30 || p.x > p.w + 30 || p.y > p.h + 30)) {
      mx = my = -1;
    }
  }
  function onUp(e) {
    if (!cv) return;
    var wasDragging = dragging;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchD0 = 0;
    if (pointers.size === 0) dragging = false;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
    cv.style.cursor = "grab";
    var p = localXY(e);
    if (wasDragging && pointers.size === 0 && movedPx < 7 && performance.now() - downT < 650) {
      var h = findAt(p.x, p.y);
      if (h && cb.select) cb.select(payload(h));
    }
  }
  function onWheel(e) {
    e.preventDefault();
    /* Firefox mouse wheels speak DOM_DELTA_LINE (deltaY ~3 per notch), Chromium sends pixels
       (~100). Normalise to approximate pixels, or one Firefox notch shifts the zoom by 0.5%
       (~54 notches to double) instead of ~20%. */
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 330;
    var k = Math.exp(-dy * 0.0018);
    zoom = clamp(zoom * k, 1, 40);
  }
  function onDbl(e) { zoom = clamp(zoom * 1.7, 1, 40); }

  /* ---------------- public API ---------------- */
  function mount(canvas, opts) {
    if (mounted) {
      if (opts) { if (opts.onSelect) cb.select = opts.onSelect; if (opts.onHover) cb.hover = opts.onHover; if (opts.onView) cb.view = opts.onView; }
      return true;
    }
    if (!canvas || !window.WORLDGEO || !canvas.getContext) return false;
    cv = canvas; ctx = cv.getContext("2d");
    if (opts) { cb.select = opts.onSelect || null; cb.hover = opts.onHover || null; cb.view = opts.onView || null; }
    GRAT = window.WORLDGEO.geoGraticule10();
    cv.style.touchAction = "none";
    cv.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("dblclick", onDbl);
    window.addEventListener("resize", function () { tier = -1; resize(); });
    resize();
    mounted = true;
    if (!raf) raf = requestAnimationFrame(loop);
    return true;
  }

  return {
    VERSION: "1.0",
    mount: mount,
    resize: resize,
    isMounted: function () { return mounted; },
    setActive: function (b) { active = !!b; if (b) resize(); },
    isActive: function () { return active; },
    setPoints: setPoints,
    setLabels: setLabels,
    setNow: setNow,
    setSpin: function (b) { spin = !!b; },
    setTerminator: function (b) { terminator = !!b; },
    getTerminator: function () { return terminator; },
    zoomBy: function (k) { zoom = clamp(zoom * k, 1, 40); },
    nudge: function (dLon, dLat) { lon = norm(lon + dLon); lat = clamp(lat + dLat, -88, 88); },
    flyTo: function (lo2, la2, z2, ms, done) {
      if (!isFinite(lo2) || !isFinite(la2)) return;
      var z1 = clamp(+z2 || zoom, 1, 40);
      vLon = vLat = 0;
      fly = { t0: performance.now(), ms: Math.max(120, +ms || 900),
              lon0: lon, lat0: lat, zoom0: zoom,
              dlon: norm(lo2 - lon), lat1: clamp(+la2, -88, 88), zoom1: z1,
              lon1: norm(+lo2), done: done || null };
    },
    jump: function (lo2, la2, z2) {
      fly = null; lon = norm(+lo2); lat = clamp(+la2, -88, 88);
      zoom = clamp(+z2 || zoom, 1, 40);
      ping = { la: lat, lo: lon, t0: performance.now() };
    },
    center: function () { return { lon: r2(lon), lat: r2(lat), zoom: r2(zoom) }; },
    hitAt: function (x, y) { var c = findAt(x, y); return c ? payload(c) : null; },
    pointAt: function (x, y) {
      if (!proj) return null;
      var dx = x - projCx, dy = projCy - y;
      if (dx * dx + dy * dy > projR * projR) return null;
      var p = proj.invert([x, y]);
      return (p && isFinite(p[0]) && isFinite(p[1])) ? [r2(p[0]), r2(p[1])] : null;
    },
    isSpinning: function () { return spin; },
    state: function () {
      var visClusters = 0;
      for (var i = 0; i < clusters.length; i++) if (clusters[i]._vis) visClusters++;
      return { ready: mounted && W > 0, points: pts.length, clusters: clusters.length, vis: visClusters,
               labels: labels.length, zoom: r2(zoom), lon: r2(lon), lat: r2(lat),
               spin: spin && !REDUCED, terminator: terminator,
               marker: nowIdx != null && (idxToPt.has(nowIdx) || !!nowGeo),
               hover: hovered ? { label: hovered.label, n: hovered.n } : null,
               frames: frames, quality: r2(quality), dpr: r2(dpr) };
    },
  };
})();
