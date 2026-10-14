/* ============================================================================
   world.js — the World View page (deploy/world.html), S1 of the v2 project.

   The full-page globe: MapLibre GL v5 (vendored) with Esri World Imagery over
   NASA GIBS Blue Marble — the stack proven in world-feed-db — fed by the same
   catalogue as index.html (geo.js indices into stations.js). Dots and clusters
   are WebGL layers (no DOM markers), the place drawer plays through the shared
   single-owner player in wr-core.js, and the v1 canvas globe (worldgeo.js +
   globe.js) is the no-WebGL fallback engine, fullscreen.

   The page owns its chrome; WR owns the data, the filters and the player.
   ============================================================================ */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var RAD = Math.PI / 180, R2D = 180 / Math.PI;
  var WR = window.WR;
  var errs = 0;
  window.addEventListener("error", function () { errs++; });

  /* the boot guard: without the catalogue there is nothing to draw. */
  if (!window.RB_META || !window.RB_STATIONS || !window.RB_GEO || !WR) {
    var sp = document.getElementById("spin");
    if (sp) sp.innerHTML = '<div style="text-align:center;max-width:470px;padding:0 20px;line-height:1.65">'
      + '<h1 style="font-size:22px;margin:0 0 10px">⚠ The station list could not be loaded</h1>'
      + '<p style="margin:0 0 14px;color:#9aa0b8">This is usually a temporary glitch or a half-finished upload. '
      + 'Please reload the page — if it keeps happening, the station data files are missing or incomplete on the server.</p>'
      + '<button id="reloadBtn" style="font:inherit;font-weight:800;cursor:pointer;background:linear-gradient(90deg,#c9ff3d,#ff3ea5);color:#0b0d12;border:0;border-radius:10px;padding:10px 18px">Reload the page</button></div>';
    var rb = document.getElementById("reloadBtn"); if (rb) rb.onclick = function () { location.reload(); };
    document.body.dataset.ready = "1";
    return;
  }

  /* ============================ page helpers ============================= */
  var toastT = null;
  function toast(msg, ms) {
    var t = $("#toast"); t.textContent = msg; t.style.display = "block";
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = "none"; }, ms || 4200);
  }
  function toastAction(msg, label, fn, ms) {          /* a toast with one button — the carry-over's one-tap resume */
    var t = $("#toast");
    t.innerHTML = "<span>" + WR.esc(msg) + "</span><button type=\"button\" id=\"toastGo\">" + WR.esc(label) + "</button>";
    t.style.display = "block"; clearTimeout(toastT);
    var b = document.getElementById("toastGo");
    if (b) b.onclick = function () { t.style.display = "none"; clearTimeout(toastT); fn(); };
    toastT = setTimeout(function () { t.style.display = "none"; }, ms || 9000);
  }
  function notice(html, kind, opts) {
    var bar = $("#notice"); if (!bar) return;
    bar.innerHTML = "<span>" + html + "</span><button type=\"button\" id=\"noticeX\" aria-label=\"Dismiss message\">✕</button>";
    bar.className = "show " + (kind || "");
    var x = document.getElementById("noticeX"); if (x) x.onclick = function () { bar.className = ""; };
    if (opts && opts.tryAgain) {
      var b = document.getElementById("noticeTry");
      if (b) b.onclick = function () { bar.className = ""; opts.tryAgain(); };
    }
  }
  var STRIP_PROXY_LOGOS = true;
  var PROXY_LOGO_HOST = /(^|\.)(gstatic\.com|googleusercontent\.com|ggpht\.com)$/;
  function logoURL(s) {
    var u = (s && s.f) || ""; if (!u || u === "null" || u === "undefined") return "";
    if (!STRIP_PROXY_LOGOS) return u;
    try { return PROXY_LOGO_HOST.test(new URL(u, location.href).hostname.toLowerCase()) ? "" : u; } catch (e) { return u; }
  }
  document.addEventListener("error", function (e) {
    var t = e.target; if (t && t.tagName === "IMG") { t.removeAttribute("src"); t.style.display = "none"; }
  }, true);

  WR.hooks.onStation = function (m) { tbarStation(m); updateNowMarker(); if (layers.recent) setTimeout(refreshRecentLayer, 400); };
  WR.hooks.onPlaying = tbarPlaying;
  WR.hooks.onVol = tbarVol;
  WR.hooks.onFavs = function () { syncSavedUI(); if (WR.filters.state.favOnly) refreshWorld(); if (layers.saved) refreshSavedLayer(); if (lastPlace) openPlace(lastPlace.i, lastPlace.la, lastPlace.lo, true); };
  WR.hooks.pickPrompt = "Pick a station first — click a dot on the globe.";
  WR.hooks.toast = toast;
  WR.hooks.toastAction = toastAction;
  WR.hooks.notice = notice;

  /* ============================== the data ==============================
     geo.js: [index into RB_STATIONS, lat, lon]. Custom stations carry their own
     [la, lo] (s.g) — the ones pinned from the old globe's "add a station here". */
  var RBG = (window.RB_GEO && Array.isArray(window.RB_GEO.pts)) ? window.RB_GEO.pts : [];
  var geoBy = new Map();
  for (var gi = 0; gi < RBG.length; gi++) { var gp = RBG[gi]; if (Array.isArray(gp) && gp.length === 3) geoBy.set(gp[0] | 0, gp); }

  var wpts = [];                 // the located, filtered set (probes + fly targets)
  var idxGeo = new Map();        // station uuid -> [la, lo] for the now-playing marker
  var lastLocated = 0, lastShown = 0, lastLabels = 0, lastUnmapped = [];
  var worldCentroid = null;

  function geoOf(s, oi, ccOff) {
    if (WR.data.isCustom(s)) return (Array.isArray(s.g) && s.g.length === 2 && isFinite(+s.g[0]) && isFinite(+s.g[1])) ? s.g : null;
    var p = geoBy.get(oi - ccOff);
    return p ? [p[1], p[2]] : null;
  }

  function ccLabel(cc) {
    var n = WR.ccName[cc] || cc || "";
    n = String(n).replace(/[^\x20-\xFF]/g, " ").replace(/\s+/g, " ").trim();   // the glyph PBF is 0-255 only
    return n;
  }

  var lastData = null;
  function refreshWorld() {
    var all = WR.data.all();
    var ccOff = all.length - WR.data.ALL.length;
    var pts = [], byCc = new Map(), sx = 0, sy = 0, sz = 0, located = 0, shown = 0, un = [];
    idxGeo = new Map();
    for (var oi = 0; oi < all.length; oi++) {
      var s = all[oi];
      if (!WR.filters.matchAll(s, {})) continue;
      shown++;
      var g = geoOf(s, oi, ccOff); if (!g) { un.push(oi); continue; }
      located++;
      var la = +g[0], lo = +g[1];
      pts.push({ i: oi, la: la, lo: lo, cu: WR.data.isCustom(s), pk: WR.filters.playable(s), st: s.s || "", cc: s.cc || "" });
      idxGeo.set(s.i, g);
      var rla = la * RAD, rlo = lo * RAD, mu = Math.cos(rla);
      var vx = mu * Math.cos(rlo), vy = mu * Math.sin(rlo), vz = Math.sin(rla);
      sx += vx; sy += vy; sz += vz;
      var m = byCc.get(s.cc) || { n: 0, x: 0, y: 0, z: 0 }; m.n++; m.x += vx; m.y += vy; m.z += vz; byCc.set(s.cc, m);
    }
    wpts = pts; lastLocated = located; lastShown = shown; lastUnmapped = un;
    var slen = Math.sqrt(sx * sx + sy * sy + sz * sz);
    worldCentroid = slen ? { la: Math.asin(sz / slen) * R2D, lo: Math.atan2(sy, sx) * R2D } : null;
    var labels = [];
    Array.from(byCc.entries()).sort(function (a, b) { return b[1].n - a[1].n; }).slice(0, 24).forEach(function (en) {
      var m = en[1], len = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
      var name = ccLabel(en[0]);
      if (!name) return;
      labels.push({ name: name, n: m.n, cc: en[0], la: Math.asin(m.z / len) * R2D, lo: Math.atan2(m.y, m.x) * R2D });
    });
    lastLabels = labels.length;
    lastData = { pts: pts, labels: labels };
    pushData();
    updateChips();
    if (unmappedOn) renderUnmapped();
    updateNowMarker();
    var sp = document.getElementById("spin"); if (sp) sp.style.display = "none";
    document.body.dataset.ready = "1";
  }

  function updateChips() {
    var c = $("#countChip"), n = lastUnmapped.length;
    c.innerHTML = "<b>" + WR.fmt(lastLocated) + "</b> on the globe · <b>" + WR.fmt(lastShown) + "</b> shown" +
      (n ? ' · <button type="button" id="btnUnmapped" class="cu" title="Browse the ' + WR.fmt(n) + ' stations with no coordinates — search, play and save them right here (shortcut: u)"><span aria-hidden="true">📍</span> <b>' + WR.fmt(n) + "</b> unmapped ›</button>" : "");
    c.title = "Every located station in the current search and filters" +
      (n ? " — " + WR.fmt(n) + " of the shown stations have no coordinates yet; the 📍 unmapped button browses them right here" : "");
    updateFlyBtn();
    syncTopH();   /* the chip's height just moved - the phone chrome anchors under it */
  }
  function updateCoords(lon, lat, zoom) {
    var la = lat >= 0 ? lat.toFixed(1) + "°N" : (-lat).toFixed(1) + "°S";
    var lo = lon >= 0 ? lon.toFixed(1) + "°E" : (-lon).toFixed(1) + "°W";
    $("#coordsChip").textContent = la + " · " + lo + " · zoom " + (+zoom).toFixed(1);
  }

  /* ============================ the engines ============================
     engine "maplibre": the 3D globe. engine "canvas": the v1 globe (globe.js +
     worldgeo.js) as the no-WebGL fallback. Both render the same filtered set. */
  var engine = null, map = null, mapReady = false, cvReady = false;
  /* the default view: the whole globe, as big as the screen allows (its diameter is
     512 * 2^zoom / pi px), so a desktop opens on a full-screen earth and a phone opens
     on one that fits its width. */
  function defaultZoom() {
    var m = Math.min(window.innerWidth, window.innerHeight);
    var z = Math.log2(0.85 * m * Math.PI / 512);
    return Math.max(1.05, Math.min(2.25, Math.round(z * 100) / 100));
  }
  var INIT = { lon: 10, lat: 24, zoom: defaultZoom() };
  var REDUCED = WR.REDUCED;
  var ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  var GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/";
  var POINT_LAYERS = ["wr-points", "wr-points-cu", "wr-points-gray"];
  var CLUSTER_LAYERS = ["wr-clusters", "wr-clusters-cu"];
  var INTERACTIVE = POINT_LAYERS.concat(CLUSTER_LAYERS);

  function webglOK() { try { return !!document.createElement("canvas").getContext("webgl2"); } catch (e) { return false; } }
  var libP = null;
  function loadLib() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (libP) return libP;
    libP = new Promise(function (resolve, reject) {
      var link = document.createElement("link"); link.rel = "stylesheet"; link.href = "maplibre/maplibre-gl.css";
      document.head.appendChild(link);
      var s = document.createElement("script"); s.src = "maplibre/maplibre-gl.js";
      s.onload = function () { window.maplibregl ? resolve(window.maplibregl) : reject(new Error("maplibre-gl.js loaded but window.maplibregl is missing")); };
      s.onerror = function () { reject(new Error("maplibre/maplibre-gl.js could not be loaded")); };
      document.head.appendChild(s);
    });
    libP.catch(function () { libP = null; });
    return libP;
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script"); s.src = src;
      s.onload = resolve; s.onerror = function () { reject(new Error(src + " could not be loaded")); };
      document.head.appendChild(s);
    });
  }
  function wrapLng(l) { return ((l + 540) % 360) - 180; }

  /* ---- the MapLibre style: raster-only, the ZERO stack ---- */
  function emptyFC() { return { type: "FeatureCollection", features: [] }; }
  var CLUSTER_RADIUS = ["interpolate", ["linear"], ["zoom"],
    0, ["step", ["get", "point_count"], 15, 100, 20, 750, 28],
    4, ["step", ["get", "point_count"], 14, 100, 19, 750, 27],
    7, ["step", ["get", "point_count"], 13, 100, 18, 750, 25],
    10, ["step", ["get", "point_count"], 12, 100, 17, 750, 23]];
  var CLUSTER_GLOW_RADIUS = ["interpolate", ["linear"], ["zoom"],
    0, ["step", ["get", "point_count"], 24, 100, 32, 750, 44.8],
    4, ["step", ["get", "point_count"], 22.4, 100, 30.4, 750, 43.2],
    7, ["step", ["get", "point_count"], 20.8, 100, 28.8, 750, 40],
    10, ["step", ["get", "point_count"], 19.2, 100, 27.2, 750, 36.8]];
  var SINGLE_RADIUS = ["interpolate", ["linear"], ["zoom"], 3.5, 2.9, 6, 4.4, 9, 5.7, 12, 7.1, 15, 8.8];
  /* the soft halo under each individual station dot — "the final dots" must read at a glance */
  var SINGLE_GLOW_RADIUS = ["interpolate", ["linear"], ["zoom"], 3.5, 7.5, 6, 11, 9, 14, 12, 17.5, 15, 22];
  /* click / hover reach beyond the dot's own circle, in CSS px — a finger is not a mouse */
  var DOT_CLICK_PAD = 15, DOT_HOVER_PAD = 12;

  function buildStyle() {
    return {
      version: 8,
      glyphs: "maplibre/fonts/{fontstack}/{range}.pbf",
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.55, 8, 0] },
      sources: {
        esri: { type: "raster", tileSize: 256, maxzoom: 19, tiles: [ESRI_TILES] },
        bluemarble: { type: "raster", tileSize: 256, maxzoom: 8, tiles: [GIBS + "BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"] },
        "wr-pts": {
          type: "geojson", data: emptyFC(),
          cluster: true, clusterRadius: 50, clusterMaxZoom: 11, clusterMinPoints: 2,
          clusterProperties: { cus: ["+", ["case", ["==", ["get", "cu"], 1], 1, 0]] }
        },
        "wr-labels": { type: "geojson", data: emptyFC() },
        "wr-now": { type: "geojson", data: emptyFC() },
        "wr-hov": { type: "geojson", data: emptyFC() },
        "wr-heat": { type: "geojson", data: emptyFC() },
        "wr-saved": { type: "geojson", data: emptyFC() },
        "wr-recent": { type: "geojson", data: emptyFC() }
      },
      layers: [
        { id: "wr-bg", type: "background", paint: { "background-color": "#05070d" } },
        { id: "wr-esri", type: "raster", source: "esri" },
        { id: "wr-bluemarble", type: "raster", source: "bluemarble", maxzoom: 8 },
        /* S3a: the density heatmap — the whole located set, not the clustered display */
        { id: "wr-heat", type: "heatmap", source: "wr-heat", layout: { visibility: "none" },
          paint: {
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 18, 4, 26, 8, 40],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 8, 1.6],
            "heatmap-opacity": 0.75,
            "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(31,227,255,0)", 0.15, "rgba(31,227,255,.55)", 0.4, "#a06bff", 0.65, "#ff3ea5", 0.9, "#ffe14d"]
          } },
        { id: "wr-clusters-glow", type: "circle", source: "wr-pts", filter: ["has", "point_count"],
          paint: { "circle-color": "#1fe3ff", "circle-radius": CLUSTER_GLOW_RADIUS, "circle-opacity": 0.14, "circle-blur": 1 } },
        { id: "wr-clusters", type: "circle", source: "wr-pts", filter: ["has", "point_count"],
          paint: { "circle-color": "#1fe3ff", "circle-radius": CLUSTER_RADIUS, "circle-opacity": 0.16,
            "circle-stroke-width": 1.4, "circle-stroke-color": "rgba(31,227,255,.85)" } },
        { id: "wr-clusters-cu", type: "circle", source: "wr-pts",
          filter: ["all", ["has", "point_count"], [">", ["get", "cus"], 0]],
          paint: { "circle-color": "#c9ff3d", "circle-radius": CLUSTER_RADIUS, "circle-opacity": 0.15,
            "circle-stroke-width": 1.6, "circle-stroke-color": "rgba(201,255,61,.85)" } },
        { id: "wr-cluster-count", type: "symbol", source: "wr-pts", filter: ["has", "point_count"],
          layout: { "text-field": "{point_count_abbreviated}", "text-font": ["NotoSansRegular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 0, 12.5, 4, 11.5, 8, 11] },
          paint: { "text-color": "#dffaff", "text-halo-color": "rgba(4, 10, 20, 0.85)", "text-halo-width": 1 } },
        /* the country tier is placed ABOVE the cluster-count text on purpose: symbol
           placement ranks by draw order (a later layer wins), and at world zoom the
           country name is the label worth reading — the bubbles keep their click. */
        { id: "wr-country-labels", type: "symbol", source: "wr-labels", maxzoom: 7,
          layout: { "text-field": ["get", "label"], "text-font": ["NotoSansRegular"],
            "text-size": ["step", ["get", "cnt"], 11, 100, 13, 400, 15],
            "text-max-width": 20, "text-padding": 3, "text-allow-overlap": false, "text-line-height": 1.15 },
          paint: { "text-color": "#eaf2ff", "text-halo-color": "rgba(4, 7, 12, 0.9)", "text-halo-width": 1.5,
            "text-opacity": ["interpolate", ["linear"], ["zoom"], 3, 1, 5.5, 0.6, 6.6, 0] } },
        { id: "wr-points-glow", type: "circle", source: "wr-pts", minzoom: 3.5,
          /* the halo — one per playable / custom station, under the dot itself */
          filter: ["all", ["!", ["has", "point_count"]], ["any", ["==", ["get", "pk"], 1], ["==", ["get", "cu"], 1]]],
          paint: { "circle-color": ["case", ["==", ["get", "cu"], 1], "#c9ff3d", "#1fe3ff"],
            "circle-radius": SINGLE_GLOW_RADIUS, "circle-blur": 0.9,
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.6, 0.32] } },
        { id: "wr-points-gray", type: "circle", source: "wr-pts", minzoom: 3.5,
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "pk"], 0], ["==", ["get", "cu"], 0]],
          paint: { "circle-radius": SINGLE_RADIUS, "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": 1.3, "circle-stroke-color": "rgba(190,200,225,.9)",
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.2, 1] } },
        { id: "wr-points", type: "circle", source: "wr-pts", minzoom: 3.5,
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "pk"], 1], ["==", ["get", "cu"], 0]],
          paint: { "circle-radius": SINGLE_RADIUS, "circle-color": "#1fe3ff",
            "circle-stroke-width": 1.2, "circle-stroke-color": "rgba(3,10,22,.9)",
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.2, 1] } },
        { id: "wr-points-cu", type: "circle", source: "wr-pts", minzoom: 3.5,
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "cu"], 1]],
          paint: { "circle-radius": SINGLE_RADIUS, "circle-color": "#c9ff3d",
            "circle-stroke-width": 1.2, "circle-stroke-color": "rgba(3,10,22,.9)",
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.2, 1] } },
        /* S3a: the saved + recently-played layers (off until their row says on) */
        { id: "wr-saved-dots", type: "circle", source: "wr-saved", layout: { visibility: "none" },
          paint: { "circle-radius": 4.2, "circle-color": "#ffe14d", "circle-stroke-width": 1.4,
            "circle-stroke-color": "#151605", "circle-opacity": 0.95 } },
        { id: "wr-recent-dots", type: "circle", source: "wr-recent", layout: { visibility: "none" },
          paint: { "circle-radius": 4.2, "circle-color": "#a06bff", "circle-stroke-width": 1.4,
            "circle-stroke-color": "#0b0c12", "circle-opacity": 0.95 } },
        { id: "wr-now-ring", type: "circle", source: "wr-now",
          paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 1.8,
            "circle-stroke-color": "#c9ff3d", "circle-stroke-opacity": 0.9 } },
        { id: "wr-now-dot", type: "circle", source: "wr-now",
          paint: { "circle-radius": 3.4, "circle-color": "#eaffb8", "circle-stroke-width": 1, "circle-stroke-color": "#c9ff3d" } },
        /* the hover spotlight: one ring that rides whatever dot (or cluster) the pointer is on —
           with the padded pick it lights up from a finger's width away, not only dead-centre */
        { id: "wr-hov-glow", type: "circle", source: "wr-hov",
          paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3.5, 15, 9, 20, 15, 26],
            "circle-color": "#ffe14d", "circle-opacity": 0.18, "circle-blur": 1 } },
        { id: "wr-hov-ring", type: "circle", source: "wr-hov",
          paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3.5, 10, 6, 11, 9, 13, 12, 15, 15, 17],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3.5, 1.8, 9, 2.4],
            "circle-stroke-color": "#ffe14d", "circle-stroke-opacity": 0.95 } }
      ]
    };
  }

  function buildFC(pts) {
    return { type: "FeatureCollection", features: pts.map(function (p) {
      return { type: "Feature", properties: { i: p.i, cu: p.cu ? 1 : 0, pk: p.pk ? 1 : 0 },
        geometry: { type: "Point", coordinates: [Math.round(p.lo * 1e6) / 1e6, Math.round(p.la * 1e6) / 1e6] } };
    }) };
  }
  function buildLabelFC(labels) {
    return { type: "FeatureCollection", features: labels.map(function (l) {
      return { type: "Feature", properties: { label: l.name + " · " + WR.fmt(l.n), cnt: l.n, cc: l.cc || "" },
        geometry: { type: "Point", coordinates: [Math.round(l.lo * 1e6) / 1e6, Math.round(l.la * 1e6) / 1e6] } };
    }) };
  }

  function pushData() {
    if (!lastData) return;
    if (engine === "maplibre" && mapReady) {
      var src = map.getSource("wr-pts"); if (src) src.setData(buildFC(lastData.pts));
      var ls2 = map.getSource("wr-labels"); if (ls2) ls2.setData(buildLabelFC(lastData.labels));
      if (layers.heat) { var hs = map.getSource("wr-heat"); if (hs) hs.setData(buildFC(lastData.pts)); }
    } else if (engine === "canvas" && cvReady && window.GlobeView) {
      GlobeView.setPoints(lastData.pts);
      GlobeView.setLabels(lastData.labels);
    }
  }

  var nowShown = false;
  function updateNowMarker() {
    var cur = WR.play.cur();
    var g = cur ? idxGeo.get(cur.i) : null;
    var i = g ? cur.i : null;
    nowShown = !!g;
    if (engine === "maplibre" && mapReady) {
      var src = map.getSource("wr-now"); if (!src) return;
      src.setData(g ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
        geometry: { type: "Point", coordinates: [g[1], g[0]] } }] } : emptyFC());
    } else if (engine === "canvas" && cvReady && window.GlobeView) {
      GlobeView.setNow(i == null ? null : WR.data.all().indexOf(cur), g ? g[0] : null, g ? g[1] : null);
    }
  }

  /* ---- maplibre boot ---- */
  function startMap() {
    return loadLib().then(function (ML) {
      engine = "maplibre";
      map = new ML.Map({
        container: "map",
        style: buildStyle(),
        center: [INIT.lon, INIT.lat],
        zoom: INIT.zoom,
        bearing: 0, pitch: 0, maxPitch: 70,
        attributionControl: false,
        fadeDuration: 200
      });
      map.on("error", function (ev) {
        errs++;
        var msg = ev && ev.error && ev.error.message ? ev.error.message : "map error";
        if (errs <= 3) console.warn("[world] " + msg);
      });
      /* the wheel bites a little harder than stock — zooming to the "final dots" must not take
         a dozen scroll notches (MapLibre default is 1/450) */
      try { if (map.scrollZoom && map.scrollZoom.setWheelZoomRate) map.scrollZoom.setWheelZoomRate(1 / 320); } catch (e) {}
      map.on("style.load", function () {
        try { map.setProjection({ type: "globe" }); } catch (e) {}
        mapReady = true;
        pushData();
        updateNowMarker();
        startPulse();
        updateCoords(INIT.lon, INIT.lat, map.getZoom());
        applyPendingSt();
        applyLayers();
      });
      map.on("movestart", function () { if (performance.now() > selfMoveUntil) bumpInput(); if (hoverLabel) hoverLeave();   /* a hover card must not survive the map moving under it */ });
      /* one hover brain: an exact hit wins; otherwise a PADDED pick — the "final dots" are small,
         so the pointer lights a station up from DOT_HOVER_PAD px away, not only dead-centre. */
      map.on("mousemove", function (e) {
        updateCoords(e.lngLat.lng, e.lngLat.lat, map.getZoom());
        var now = performance.now();
        if (now - lastHoverScan < 60) return;
        lastHoverScan = now;
        var hit = null;
        try { hit = map.queryRenderedFeatures(e.point, { layers: INTERACTIVE })[0] || null; } catch (err) {}
        if (hit) { hoverFeature({ point: e.point, features: [hit] }); return; }
        var f = pickNear(e.point, DOT_HOVER_PAD, POINT_LAYERS);
        if (f) { pointHover({ point: e.point, features: [f] }); return; }
        if (hoverLabel) hoverLeave();
      });
      map.on("mouseout", function () { hoverLeave(); });
      /* S3c+: dragging belongs to the globe itself — a drag starting on the empty background
         must not spin the planet (the space around it belongs to the garden). Capture-phase, so
         the gate runs before MapLibre's own drag handler. */
      window.addEventListener("pointerdown", function (e) {
        if (!(engine === "maplibre" && mapReady)) return;
        var g = gvGeo();
        try { if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > g.r * 1.02) map.dragPan.disable(); } catch (err) {}
      }, { capture: true });
      window.addEventListener("pointerup", function () {
        if (engine === "maplibre" && mapReady) { try { map.dragPan.enable(); } catch (err) {} }
      }, { capture: true });
      map.on("click", function (e) {
        if (map.queryRenderedFeatures(e.point, { layers: INTERACTIVE }).length) return;   /* an exact hit — its own handler owns the click */
        var f = pickNear(e.point, DOT_CLICK_PAD, POINT_LAYERS);
        if (f) { var ev = { point: e.point, features: [f] }; if (!farSide(ev)) { dotClick(ev); return; } }
        closePlace();
      });
      map.on("click", CLUSTER_LAYERS, clusterClick);
      map.on("click", POINT_LAYERS, dotClick);
      map.on("click", "wr-country-labels", labelClick);
      /* the container can report a zero-size box for a moment; kick it twice */
      setTimeout(function () { if (map && !map._removed) map.resize(); }, 60);
      setTimeout(function () { if (map && !map._removed) map.resize(); }, 600);
      return true;
    });
  }

  /* the globe hides its far side, but MapLibre still hit-tests those features in the space
     OUTSIDE the disc (Moddy: station cards floating around the globe). A hover or click on a
     feature that is not on this side of the sphere is ignored. */
  function farSide(e) {
    if (!(engine === "maplibre" && mapReady)) return false;
    try {
      if (e && e.point) {                       /* anything hovered well past the visible face is not ours */
        var gg = gvGeo();
        if (Math.hypot(e.point.x - gg.cx, e.point.y - gg.cy) > gg.r * 1.02) return true;
      }
      var f = e && e.features && e.features[0];
      var p = f && f.geometry && f.geometry.coordinates; if (!p) return false;
      var R = Math.PI / 180, c = map.getCenter();
      var ax = Math.cos(c.lat * R) * Math.cos(c.lng * R), ay = Math.cos(c.lat * R) * Math.sin(c.lng * R), az = Math.sin(c.lat * R);
      var bx = Math.cos(p[1] * R) * Math.cos(p[0] * R), by = Math.cos(p[1] * R) * Math.sin(p[0] * R), bz = Math.sin(p[1] * R);
      return (ax * bx + ay * by + az * bz) < 0.02;
    } catch (err) { return false; }
  }
  function clusterClick(e) {
    if (farSide(e)) return;
    var f = e.features && e.features[0]; if (!f) return;
    /* S3b-2: the country tier draws above the bubbles, so a click that lands on a
       label glyph belongs to the explore list — zooming underneath reads as a bug. */
    if (map.queryRenderedFeatures(e.point, { layers: ["wr-country-labels"] }).length) return;
    var coords = f.geometry.coordinates.slice();
    var src = map.getSource("wr-pts");
    var cid = f.properties.cluster_id;
    if (cid == null || !src.getClusterExpansionZoom) { map.easeTo({ center: coords, zoom: map.getZoom() + 1.2, duration: 500 }); return; }
    src.getClusterExpansionZoom(cid).then(function (z) {
      /* the expansion zoom is where the cluster splits, which can be barely past the
         current one; the click also has to FEEL like it went somewhere, so the jump is
         at least +0.9, and never past the globe's street zoom. */
      var target = Math.min(Math.max(z + 0.25, map.getZoom() + 0.9), 16);
      map.easeTo({ center: coords, zoom: target, duration: 520 });
    }).catch(function () { map.easeTo({ center: coords, zoom: map.getZoom() + 1.2, duration: 500 }); });
  }
  function dotClick(e) {
    if (farSide(e)) return;
    var f = e.features && e.features[0]; if (!f) return;
    var i = f.properties.i | 0;
    var coords = f.geometry.coordinates;
    openPlace(i, coords[1], coords[0]);
  }
  var hoverLabel = null, hovOn = false, lastHoverScan = 0;
  /* the padded pick: the nearest dot whose rendered circle lands within `pad` CSS px of the
     point — and the nearest one wins. This is what makes the small "final dots" comfortable
     to hit: a click or hover lands on a station from DOT_CLICK_PAD / DOT_HOVER_PAD px away. */
  function pickNear(point, pad, layers) {
    if (!(engine === "maplibre" && mapReady) || !map || !map.queryRenderedFeatures) return null;
    var feats = [];
    try { feats = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: layers }); }
    catch (err) { return null; }
    var best = null, bd = 1e9, lim = pad * pad * 1.6;
    for (var k = 0; k < feats.length; k++) {
      var f = feats[k], c = f.geometry && f.geometry.coordinates; if (!c) continue;
      var p; try { p = map.project(c); } catch (err2) { continue; }
      var dx = p.x - point.x, dy = p.y - point.y, d2 = dx * dx + dy * dy;
      if (d2 <= lim && d2 < bd) { bd = d2; best = f; }
    }
    return best;
  }
  function hoverFeature(e) {
    var f = e.features && e.features[0]; if (!f) return;
    var id = f.layer && f.layer.id;
    if (id && CLUSTER_LAYERS.indexOf(id) >= 0) clusterHover(e); else pointHover(e);
  }
  /* the yellow spotlight that rides the hovered dot / cluster */
  function setHoverRing(co) {
    if (!(engine === "maplibre" && mapReady) || !map) return;
    var src = null; try { src = map.getSource("wr-hov"); } catch (err) {}
    if (!src) return;
    if (co) {
      try { src.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: co } }] }); hovOn = true; } catch (err) {}
    } else if (hovOn) { try { src.setData(emptyFC()); } catch (err) {} hovOn = false; }
  }
  function showTip(pt, html) {
    var tip = $("#tip");
    tip.innerHTML = html; tip.style.display = "block";
    var host = $("#map").getBoundingClientRect();
    var x = Math.min(host.left + pt.x + 16, Math.max(8, host.left + host.width - 260));
    var y = Math.min(host.top + pt.y + 16, Math.max(8, host.top + host.height - 100));
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function pointHover(e) {
    if (farSide(e)) return;
    var f = e.features && e.features[0]; if (!f) return;
    var s = WR.data.all()[f.properties.i | 0]; if (!s) return;
    hoverLabel = s.n;
    map.getCanvas().style.cursor = "pointer";
    var co = f.geometry && f.geometry.coordinates;
    setHoverRing(co);
    showTip(e.point, "<b>" + WR.esc(s.n) + "</b><br><span class=\"mut\">" + WR.flag(s.cc) + " " +
      WR.esc([WR.countryOf(s), s.s].filter(Boolean).join(" · ")) + (s.x ? " · " + WR.esc(s.x) : "") + "</span>" +
      (co ? "<br><span class=\"mut\">🕒 ≈" + localTimeAt(co[0]) + " there — solar time</span>" : "") +
      "<br><span class=\"mut\">click to open the station player</span>");
  }
  function clusterHover(e) {
    if (farSide(e)) return;
    var f = e.features && e.features[0]; if (!f) return;
    var n = f.properties.point_count | 0, cus = (f.properties.cus | 0) > 0;
    hoverLabel = n + " stations";
    map.getCanvas().style.cursor = "pointer";
    setHoverRing(f.geometry && f.geometry.coordinates);
    showTip(e.point, "<b>" + WR.fmt(n) + "</b> station" + (n === 1 ? "" : "s") + (cus ? " <span class=\"mut\">· includes yours</span>" : "") +
      "<br><span class=\"mut\">click to zoom in</span>");
  }
  function hoverLeave() { hoverLabel = null; if (map) map.getCanvas().style.cursor = ""; var t = $("#tip"); t.style.display = "none"; setHoverRing(null); }

  var pulseT = null;
  function startPulse() {
    if (pulseT) return;
    pulseT = setInterval(function () {
      if (!mapReady || !map || document.hidden || !nowShown) return;
      if (REDUCED) return;
      var r = 8 + 5.5 * (0.5 + 0.5 * Math.sin(performance.now() / 320));
      try {
        map.setPaintProperty("wr-now-ring", "circle-radius", r);
        map.setPaintProperty("wr-now-ring", "circle-stroke-opacity", 0.35 + 0.55 * (1 - (r - 8) / 5.5));
      } catch (e) {}
    }, 160);
  }

  /* ---- canvas fallback boot ---- */
  function startCanvas(why) {
    engine = "canvas";
    return loadScript("worldgeo.js")
      .then(function () { return loadScript("globe.js"); })
      .then(function () {
        var cv = $("#globe");
        $("#map").style.display = "none";
        cv.hidden = false;
        cvReady = !!window.GlobeView.mount(cv, { onSelect: canvasSelect, onHover: canvasHover, onView: function (v) { updateCoords(v.lon, v.lat, v.zoom); } });
        if (!cvReady) { notice("⚠ The map could not start in this browser.", "warn"); return; }
        GlobeView.setTerminator(WR.ls.get("globe-day", true));
        GlobeView.setSpin(!REDUCED);
        pushData();
        updateNowMarker();
        updateCoords(INIT.lon, INIT.lat, 1);
        applyPendingSt();
        applyLayers();
        if (why.charAt(0) === "?") notice("ℹ The classic globe view is on (asked for with " + WR.esc(why) + ") — everything still works.", "info");
        else notice("ℹ This browser can't run the 3D globe (" + WR.esc(why) + "), so the classic view is showing — everything still works.", "info");
      });
  }
  function canvasSelect(p) {
    if (!p || !p.idxs || !p.idxs.length) return;
    if (p.n === 1) openPlace(p.idxs[0], p.la, p.lo);
    else {
      var z = window.GlobeView.state().zoom;
      GlobeView.flyTo(p.lo, p.la, Math.min(z * 1.8, 9), 600);
    }
  }
  function canvasHover(p) {
    if (!p) { $("#tip").style.display = "none"; hoverLabel = null; return; }
    var names = p.idxs.slice(0, 3).map(function (i) { return WR.data.all()[i] && WR.data.all()[i].n; }).filter(Boolean);
    hoverLabel = p.label || p.n + " stations";
    var cv = $("#globe").getBoundingClientRect();
    $("#tip").innerHTML = "<b>" + WR.esc(p.label || "This place") + "</b>" + (p.n > 1 ? " <span class=\"mut\">· " + WR.fmt(p.n) + " stations</span>" : "") +
      (names.length ? "<br><span class=\"mut\">" + WR.esc(names.join(" · ")) + (p.n > 3 ? " …" : "") + "</span>" : "");
    $("#tip").style.display = "block";
    $("#tip").style.left = Math.min(cv.left + p.x + 14, Math.max(8, cv.left + cv.width - 260)) + "px";
    $("#tip").style.top = Math.min(cv.top + p.y + 14, Math.max(8, cv.top + cv.height - 90)) + "px";
  }

  function startEngine() {
    var forced = null;
    try { forced = new URLSearchParams(location.search).get("engine"); } catch (e) {}
    if (forced === "canvas") { startCanvas("?engine=canvas"); return; }
    if (!webglOK() && forced !== "maplibre") { startCanvas("no WebGL2"); return; }
    startMap().catch(function (err) {
      console.warn("[world] maplibre failed:", err);
      startCanvas((err && err.message) || "engine error");
    });
  }

  /* ---- engine facade for the chrome ---- */
  function vZoomIn() { if (engine === "maplibre" && mapReady) map.easeTo({ zoom: map.getZoom() + 0.62, duration: 260 }); else if (engine === "canvas" && cvReady) GlobeView.zoomBy(1.5); }
  function vZoomOut() { if (engine === "maplibre" && mapReady) map.easeTo({ zoom: map.getZoom() - 0.62, duration: 260 }); else if (engine === "canvas" && cvReady) GlobeView.zoomBy(0.68); }
  /* while a zoom button is HELD: a steady accumulating target, stepped per animation frame by
     the time that frame actually took — the zoom keeps an even speed on any machine and never
     stalls waiting on a timer (fixed-cadence timers throttle under page jank right when the
     user is holding the button — measured: a 1.1 s hold moved +0.5 instead of +3). */
  var zoomHoldT = { in: null, out: null };
  function vZoomHold(dir, dtMs) {
    var k = Math.max(0.05, Math.min(1.5, (dtMs || 160) / 160));
    if (engine === "maplibre" && mapReady) {
      var key = dir > 0 ? "in" : "out";
      var base = (zoomHoldT[key] == null) ? map.getZoom() : zoomHoldT[key];
      zoomHoldT[key] = Math.max(0.2, Math.min(21.5, base + dir * 0.5 * k));
      try { map.jumpTo({ zoom: zoomHoldT[key] }); } catch (e) {}
    } else if (engine === "canvas" && cvReady) GlobeView.zoomBy(Math.pow(dir > 0 ? 1.4 : 0.71, k));
  }
  function vHome() {
    if (engine === "maplibre" && mapReady) map.flyTo({ center: [INIT.lon, INIT.lat], zoom: INIT.zoom, bearing: 0, pitch: 0, duration: 900, essential: true });
    else if (engine === "canvas" && cvReady) GlobeView.jump(INIT.lon, INIT.lat, 1);
  }
  function vFly(lo, la, z, ms, done) {
    if (engine === "maplibre" && mapReady) {
      map.flyTo({ center: [lo, la], zoom: z, duration: ms || 900, essential: true });
      if (done) { map.once("moveend", done); setTimeout(done, (ms || 900) + 200); }
    } else if (engine === "canvas" && cvReady) GlobeView.flyTo(lo, la, z, ms || 900, done);
  }

  /* ---- idle drift: the globe turns on its own when nobody is touching it.
     Any input (drag / wheel / key / touch) pauses it for 5 s; a hovered dot,
     an open drawer or a hidden tab pauses it outright; reduced motion never
     spins. (The canvas fallback keeps the v1 rule: pointer-on-canvas pauses.) */
  var lastAct = 0, selfMoveUntil = 0;
  function bumpInput() { lastAct = performance.now(); }
  ["pointerdown", "pointermove", "wheel", "touchstart", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, bumpInput, { passive: true });
  });
  function spinActive() {
    if (engine === "maplibre") {
      return !!(mapReady && map && !REDUCED && !document.hidden &&
        (performance.now() - lastAct > 5000) && !placePanelOpen() && !hoverLabel && !map.isMoving());
    }
    if (engine === "canvas" && cvReady) return !!GlobeView.state().spin;
    return false;
  }
  setInterval(function () {
    if (engine !== "maplibre" || !mapReady || REDUCED || document.hidden) return;
    if (performance.now() - lastAct < 5000) return;
    if (placePanelOpen() || hoverLabel) return;
    if (map.isMoving() || $("#modal").style.display === "flex") return;
    selfMoveUntil = performance.now() + 150;
    var c = map.getCenter();
    map.jumpTo({ center: [wrapLng(c.lng + 0.08), c.lat] });
  }, 50);

  /* ============================ the drawer ============================ */
  var placeGeo = null, lastPlace = null;
  var unmappedOn = false, unRows = null, unShown = 0, UNPAGE = 150;
  function placePanelOpen() { return !$("#placePanel").hidden; }
  function closePlace() { $("#placePanel").hidden = true; lastPlace = null; exploreCc = null; exploreFly = null; unmappedOn = false; unRows = null; $("#placeRand").hidden = true; writeHash(); }
  function openPlace(i, la, lo, keep) {
    var s = WR.data.all()[i]; if (!s) return;
    if (!keep) lastPlace = { i: i, la: la, lo: lo };
    exploreCc = null; exploreFly = null; unmappedOn = false;
    $("#placeRand").hidden = true;
    $("#placeCopy").hidden = false;
    $("#placeListLink").title = "Open this station in the stations list";
    $("#placeTitle").textContent = s.n || "Unknown station";
    $("#placeSub").textContent = WR.flag(s.cc) + " " + [WR.countryOf(s), s.s].filter(Boolean).join(" · ") +
      (s.x ? " · " + s.x + (s.b ? " " + s.b + "kbps" : "") : "");
    var nm = s.n || "Unknown station";
    $("#placeList").innerHTML = '<div class="srow" data-idx="' + i + '">'
      + '<div class="sn"><b data-pact="info" title="Station details">' + WR.esc(nm) + '</b>'
      + '<span>' + WR.flag(s.cc) + ' ' + WR.esc([WR.countryOf(s), s.s].filter(Boolean).join(" · ")) + (s.x ? ' · ' + WR.esc(s.x) : '') + '</span></div>'
      + '<button class="sb" data-pact="play" title="Play ' + WR.esc(nm) + '">▶</button>'
      + '<button class="sb" data-pact="fav" title="' + (WR.fav.has(s.i) ? "Remove from" : "Save to") + ' My stations">' + (WR.fav.has(s.i) ? "★" : "☆") + '</button></div>';
    $("#placeNote").hidden = true;
    $("#placeListLink").href = "index.html#q=" + encodeURIComponent(s.n || "");
    var site = $("#placeSite");
    if (s.hp) { site.hidden = false; site.href = s.hp; } else site.hidden = true;
    placeGeo = { la: la, lo: lo };
    $("#placePanel").hidden = false;
    bumpInput();
    if (layersOpen) setLayersOpen(false);
    writeHash();
  }
  $("#placeClose").addEventListener("click", closePlace);
  $("#placeList").addEventListener("click", function (e) {
    if (e.target.closest("#placeMore")) { appendUnmapped(); return; }
    var xr = e.target.closest(".prow");
    if (xr) { exploreJump(+xr.dataset.x); return; }
    var b = e.target.closest("[data-pact]"); if (!b) return;
    var row = b.closest(".srow"); if (!row) return;
    var s = WR.data.all()[+row.dataset.idx]; if (!s) return;
    if (b.dataset.pact === "play") {
      if (unmappedOn) { doPlay(s); return; }   /* no dot to fly to — and picking through thousands is a browsing job, so the list stays up */
      closePlace();
      var g = idxGeo.get(s.i);
      if (g) vFly(g[1], g[0], Math.max(3, Math.min((engine === "maplibre" && mapReady ? map.getZoom() : 2) * 1.15, 7)), 800);
      doPlay(s);
    } else if (b.dataset.pact === "fav") { WR.fav.toggle(s); b.textContent = WR.fav.has(s.i) ? "★" : "☆"; }
    else { closePlace(); showInfo(s); }
  });
  $("#placeCopy").addEventListener("click", function () {
    if (lastPlace) { var s = WR.data.all()[lastPlace.i]; if (s) WR.copyText(s.u, "Stream URL"); }
  });

  /* ---- S3b-2: the explore tiers — click a country label, pick one of its places ----
     A country label opens the places the catalogue lists for it (its states / cities,
     counted over the located + filtered set). A row flies the globe there; the list
     stays up for the next jump. Honest by construction: only region names the data
     actually carries appear, and the note says how many of the country's stations
     list none. */
  var exploreCc = null, exploreRows = [], exploreFly = null, EXPLORE_CAP = 60, EXPLORE_ZOOM = 5.2;
  function labelClick(e) {
    var f = e.features && e.features[0]; if (!f) return;
    /* a station dot's own click keeps its meaning — including the padded reach; the label
       only wins where no dot is within clicking distance */
    if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
    if (pickNear(e.point, DOT_CLICK_PAD, POINT_LAYERS)) return;
    var cc = f.properties && f.properties.cc; if (cc) openExplore(cc);
  }
  function openExplore(cc) {
    cc = String(cc || "").toUpperCase(); if (!cc) return;
    var total = 0, bySt = new Map();
    for (var k = 0; k < wpts.length; k++) {
      var p = wpts[k]; if (p.cc !== cc) continue;
      total++;
      var st = String(p.st || "").trim(); if (!st) continue;
      var m = bySt.get(st) || { n: 0, x: 0, y: 0, z: 0 };
      m.n++;
      var rla = p.la * RAD, rlo = p.lo * RAD, mu = Math.cos(rla);
      m.x += mu * Math.cos(rlo); m.y += mu * Math.sin(rlo); m.z += Math.sin(rla);
      bySt.set(st, m);
    }
    var named = 0;
    exploreRows = [];
    bySt.forEach(function (m, st) {
      var len = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
      named += m.n;
      exploreRows.push({ st: st, n: m.n, la: Math.asin(m.z / len) * R2D, lo: Math.atan2(m.y, m.x) * R2D });
    });
    exploreRows.sort(function (a, b) { return b.n - a.n || (a.st < b.st ? -1 : (a.st > b.st ? 1 : 0)); });
    var top = exploreRows.slice(0, EXPLORE_CAP);
    var nm = ccLabel(cc) || cc;
    var html = "";
    for (var r = 0; r < top.length; r++) {
      html += '<button type="button" class="prow" data-x="' + r + '" data-n="' + top[r].n + '">'
        + '<span class="x-n">' + WR.esc(top[r].st) + '</span><span class="x-c">' + WR.fmt(top[r].n) + '</span></button>';
    }
    $("#placeTitle").textContent = WR.flag(cc) + " " + nm;
    $("#placeSub").textContent = WR.fmt(total) + " on the globe · " + (top.length ? "pick a place to fly there" : "no named places in the catalogue");
    $("#placeList").innerHTML = html || '<div class="x-empty">The catalogue lists no region name for this country — its stations stay on the globe all the same.</div>';
    var notes = [];
    if (exploreRows.length > top.length) notes.push("showing the top " + top.length + " places, biggest first");
    var stateless = total - named;
    if (stateless > 0) notes.push(WR.fmt(stateless) + " mapped station" + (stateless === 1 ? "" : "s") + " here list no region and stay on the globe");
    var pn = $("#placeNote"); pn.textContent = notes.join(" · "); pn.hidden = !notes.length;
    lastPlace = null; placeGeo = null; exploreCc = cc; exploreFly = null; unmappedOn = false;
    $("#placeRand").hidden = true;
    $("#placeListLink").href = "index.html#q=" + encodeURIComponent(nm);
    $("#placeSite").hidden = true;
    $("#placeCopy").hidden = true;
    $("#placePanel").hidden = false;
    bumpInput();
    if (layersOpen) setLayersOpen(false);
    writeHash();
  }
  function exploreJump(r) {
    var row = exploreRows[r]; if (!row) return;
    exploreFly = { st: row.st, n: row.n, la: row.la, lo: row.lo, z: EXPLORE_ZOOM };
    vFly(row.lo, row.la, EXPLORE_ZOOM, 900);
  }

  /* ---- the unmapped drawer (2026-10-13): the stations the catalogue cannot place stay
     reachable from this page. The count chip's 📍 segment opens this list; the search and
     filters prune it exactly like the globe; a row plays through the usual path and the
     list stays up — there is no dot to fly to for these, and picking through thousands is
     a browsing job. "Play a random one" tunes one in. */
  function unmappedListOpen() { return placePanelOpen() && unmappedOn; }
  function unRowHTML(i, s) {
    var nm = s.n || "Unknown station";
    return '<div class="srow" data-idx="' + i + '">'
      + '<div class="sn"><b data-pact="info" title="Station details">' + WR.esc(nm) + '</b>'
      + '<span>' + WR.flag(s.cc) + ' ' + WR.esc([WR.countryOf(s), s.s].filter(Boolean).join(" · ")) + (s.x ? ' · ' + WR.esc(s.x) : '') + '</span></div>'
      + '<button class="sb" data-pact="play" title="Play ' + WR.esc(nm) + '">▶</button>'
      + '<button class="sb" data-pact="fav" title="' + (WR.fav.has(s.i) ? "Remove from" : "Save to") + ' My stations">' + (WR.fav.has(s.i) ? "★" : "☆") + '</button></div>';
  }
  function openUnmapped() {
    lastPlace = null; placeGeo = null; exploreCc = null; exploreFly = null;
    unmappedOn = true;
    $("#placeSite").hidden = true; $("#placeCopy").hidden = true;
    $("#placeListLink").title = "Open the stations list — carries your search";
    renderUnmapped();
    $("#placePanel").hidden = false;
    bumpInput();
    if (layersOpen) setLayersOpen(false);
    writeHash();
  }
  function renderUnmapped() {
    var all = WR.data.all();
    var rows = lastUnmapped.slice();
    rows.sort(function (a, b) {
      var sa = all[a] || {}, sb = all[b] || {};
      return ((sb.k | 0) - (sa.k | 0)) || ((sb.v | 0) - (sa.v | 0)) || String(sa.n || "").localeCompare(String(sb.n || ""));
    });
    unRows = rows; unShown = 0;
    $("#placeTitle").textContent = "📍 Unmapped stations";
    $("#placeSub").textContent = WR.fmt(rows.length) + " in this search — the catalogue lists no coordinates for them, so they have no dot to sit on";
    var st = WR.filters.state;
    $("#placeListLink").href = "index.html" + (st.q ? "#q=" + encodeURIComponent(st.q) : "");
    var list = $("#placeList");
    if (!rows.length) {
      list.innerHTML = '<div class="x-empty">Nothing here — every station in this search has coordinates.</div>';
      $("#placeNote").hidden = true;
      $("#placeRand").hidden = true;
    } else {
      list.innerHTML = "";
      appendUnmapped();
      $("#placeRand").hidden = false;
    }
  }
  function appendUnmapped() {
    if (!unRows) return;
    var all = WR.data.all(), end = Math.min(unRows.length, unShown + UNPAGE), html = "";
    for (var k = unShown; k < end; k++) { var s = all[unRows[k]]; if (s) html += unRowHTML(unRows[k], s); }
    var list = $("#placeList"), more = document.getElementById("placeMore");
    if (more) more.insertAdjacentHTML("beforebegin", html); else list.insertAdjacentHTML("beforeend", html);
    unShown = end;
    var left = unRows.length - unShown;
    if (left > 0) {
      var lbl = "Show " + Math.min(UNPAGE, left) + " more ›";
      if (more) more.textContent = lbl;
      else list.insertAdjacentHTML("beforeend", '<button type="button" class="morebtn" id="placeMore">' + lbl + "</button>");
    } else if (more) more.remove();
    updateUnmappedNote();
  }
  function updateUnmappedNote() {
    var pn = $("#placeNote");
    if (!unRows || !unRows.length) { pn.hidden = true; return; }
    pn.textContent = unShown < unRows.length
      ? "showing the first " + WR.fmt(unShown) + " of " + WR.fmt(unRows.length) + ", most popular first"
      : "all " + WR.fmt(unRows.length) + " here, most popular first";
    pn.hidden = false;
  }
  function playRandomUnmapped() {
    if (!unRows || !unRows.length) return;
    var all = WR.data.all(), pool = [], k, s;
    for (k = 0; k < unRows.length; k++) { s = all[unRows[k]]; if (s && WR.filters.playable(s)) pool.push(s); }
    if (!pool.length) for (k = 0; k < unRows.length; k++) { s = all[unRows[k]]; if (s) pool.push(s); }
    s = pool[Math.floor(Math.random() * pool.length)];
    if (!s) return;
    toast("🎲 " + s.n, 4200);
    doPlay(s);
  }
  $("#placeRand").addEventListener("click", playRandomUnmapped);
  $("#countChip").addEventListener("click", function (e) {
    if (!e.target.closest("#btnUnmapped")) return;
    if (unmappedListOpen()) closePlace(); else openUnmapped();
  });

  function doPlay(s) {
    var k = WR.play.playKind(s);
    if (k !== 1) { WR.play.unplayableNotice(s, k); return; }
    WR.play.requestPlay(WR.play.M(s));
  }

  /* ============================= the modal ============================= */
  var TAGCLS = ["t0", "t1", "t2", "t3", "t4"];
  function showInfo(m) {
    var s = m, pk = WR.play.playKind(s);
    var allTags = WR.tokens(s.t);
    var rows = [["Country", WR.flag(s.cc) + " " + WR.esc(WR.countryOf(s))], ["State", WR.esc(s.s)], ["Language", WR.esc(s.l)],
      ["Format", WR.esc((s.x || "?") + (s.b ? " · " + s.b + " kbps" : "") + (s.hl ? " · HLS" : ""))],
      ["Votes", WR.fmt(s.v)], ["Clicks", WR.fmt(s.k)],
      ["Playback", pk === 1 ? "✅ plays in this browser" : "⚠ " + WR.play.KIND_TEXT[pk].tag + " — " + WR.play.KIND_TEXT[pk].why],
      ["Stream", "<code>" + WR.esc(s.u) + "</code>"]].filter(function (r) { return r[1]; });
    $("#mHead").innerHTML = (logoURL(s) ? '<img class="fav" style="width:52px;height:52px" src="' + WR.esc(logoURL(s)) + '" alt="">' : "")
      + '<div class="h1"><span class="nm">' + WR.esc(s.n) + '</span><div class="loc">' + WR.flag(s.cc) + ' ' + WR.esc(WR.countryOf(s)) + '</div></div>';
    $("#mBody").innerHTML = (allTags.length ? '<div class="tags" style="margin-bottom:10px">' + allTags.map(function (t, i) { return '<span class="tag ' + TAGCLS[i % 5] + '">' + WR.esc(t) + '</span>'; }).join("") + '</div>' : "")
      + '<table>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join("") + '</table>';
    $("#mActs").innerHTML = '<button class="btn pink" id="mPlay">▶ Play</button>'
      + '<button class="btn" id="mFav">' + (WR.fav.has(s.i) ? "★ Saved" : "☆ Save") + '</button>'
      + '<a class="btn" href="' + WR.esc(s.u) + '" target="_blank" rel="noopener">Open stream</a>'
      + (s.hp ? '<a class="btn" href="' + WR.esc(s.hp) + '" target="_blank" rel="noopener">🌐 Station website</a>' : '<button class="btn" disabled>No website listed</button>')
      + '<button class="btn" id="mCopy">Copy stream URL</button><button class="btn" id="mClose">Close</button>';
    $("#modal").style.display = "flex";
    $("#mPlay").onclick = function () { $("#modal").style.display = "none"; doPlay(s); };
    $("#mFav").onclick = function () { WR.fav.toggle(s); $("#mFav").textContent = WR.fav.has(s.i) ? "★ Saved" : "☆ Save"; };
    $("#mCopy").onclick = function () { WR.copyText(s.u, "Stream URL"); };
    $("#mClose").onclick = function () { $("#modal").style.display = "none"; };
  }
  $("#modal").addEventListener("click", function (e) { if (e.target === $("#modal")) $("#modal").style.display = "none"; });

  /* =========================== the transport =========================== */
  function tbarStation(m) {
    var nm = $("#tName"), meta = $("#tMeta"), art = $("#tArt");
    if (!m) {
      nm.textContent = "WORLD VIEW";
      meta.textContent = "click a dot on the globe to play";
      art.src = art.dataset.idle || art.src;
      return;
    }
    nm.textContent = m.n;
    meta.textContent = WR.flag(m.cc) + " " + WR.countryOf(m) + " · " + (m.l || "") + " · " + (m.x || "") + (m.b ? " " + m.b + "kbps" : "");
    var u = logoURL(m);
    if (u) { var im = new Image(); im.onload = function () { art.src = u; }; im.src = u; }
  }
  function tbarPlaying(on, info) {
    var b = $("#tPlay");
    b.classList.toggle("playing", !!on && info.mine);
    b.classList.toggle("pop", !!on && !info.mine);
    b.textContent = on ? (info.mine ? "⏸" : "●") : "▶";
    b.title = on ? (info.mine ? "Pause" : "Playing in another window — click to move it here") : "Play / pause";
    var st = $("#tState");
    st.style.display = on ? "" : "none";
    if (on) {
      st.textContent = info.mine ? "playing here" : "playing in " + (info.remoteKind === "pop" ? "pop-out" : "another tab");
      st.className = "badge " + (info.mine ? "on" : "remote");
    }
  }
  function tbarVol(v) { $("#tVol").value = v; $("#tVolPct").textContent = Math.round(v * 100) + "%"; }
  $("#tPlay").addEventListener("click", function () { WR.play.requestToggle(); });
  $("#tStop").addEventListener("click", function () { WR.play.requestStop(); });
  $("#tVol").addEventListener("input", function (e) { WR.play.setVol(+e.target.value); });

  /* ---- the pop-out mini player (S3c): the window index.html opens, so the music truly rides
     between the two pages. A real pop-up window on a desktop; on a mobile browser the same
     click opens a tab (popout.html holds itself to a centred column there). The World View has
     no page chrome to give up, so there is no dock here - just the window - and the normal
     owner relay carries the stream out and back. ---- */
  var winPop = null;
  var popAliveFresh = function () { return (Date.now() - (WR.ls.get("pop-alive", 0) || 0)) < 5000; };
  var popOutOpen = function () { return !!((winPop && !winPop.closed) || popAliveFresh()); };
  function mobileBrowser() {
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;   // iPadOS reports itself as a Mac
    try { if (window.matchMedia && window.matchMedia("(hover:none) and (pointer:coarse)").matches) return true; } catch (e) {}
    return false;
  }
  function popSync() {
    var b = $("#tPop"); if (!b) return;
    var open = popOutOpen();
    b.classList.toggle("on", open);
    b.setAttribute("aria-pressed", String(open));
    b.title = open ? "Hide the mini player — playback continues here"
                   : "Pop out the mini player — it keeps playing while you explore the globe";
  }
  function popupBlockedNotice() {
    notice("🚫 <b>Your browser blocked the pop-up</b>, so the mini player could not open. Click your browser's <b>“pop-ups blocked”</b> icon in the address bar, choose <b>always allow pop-ups for this site</b>, then press the pop-out button again.", "warn");
  }
  function togglePopOut() {
    if (winPop && !winPop.closed) { try { winPop.close(); } catch (e) {} winPop = null; popSync();
      toast("Mini player hidden — playback continues on this page."); return; }
    if (popAliveFresh()) { WR.chan.post({ type: "pop-hide" });     // it lives in another tab: ask it to close itself
      popSync(); toast("Mini player hidden — playback continues on this page."); return; }
    var w = null;
    try {
      w = mobileBrowser()
        ? window.open("popout.html", "rbgPop")
        : window.open("popout.html", "rbgPop", "popup=1,width=330,height=250,left=" + Math.max(0, (screen.availWidth - 340)) + ",top=" + Math.max(0, (screen.availHeight - 300)) + ",resizable=yes,scrollbars=no");
    } catch (e) { w = null; }
    if (w) {
      winPop = w;
      /* it opens small and out of the way: this page keeps the focus, the player expands on click */
      var keepFocus = function () { try { window.focus(); } catch (e) {} };
      setTimeout(keepFocus, 120); setTimeout(keepFocus, 800);
      /* some blockers let the window open and then close it again - treat that as blocked too */
      setTimeout(function () { if (winPop && winPop.closed) { winPop = null; popSync(); popupBlockedNotice(); } }, 1100);
      toast("Mini player opened minimised — click it to expand.");
      popSync();
    } else popupBlockedNotice();
  }
  if ($("#tPop")) $("#tPop").addEventListener("click", togglePopOut);
  window.addEventListener("message", function (e) { if (e.data === "rbg-pop-closed") { winPop = null; popSync(); } });
  setInterval(popSync, 1000);
  popSync();

  /* ============================== the chrome ============================== */
  /* the zoom buttons: click = a firm step, press-and-hold = keep zooming (the gesture a
     person expects from a map control; a plain tap still steps exactly once) */
  function bindZoomHold(sel, fn, dir) {
    var btn = $(sel); if (!btn) return;
    var t = null, raf = null, last = 0, rep = false;
    function stopHold() { if (t) { clearTimeout(t); t = null; } if (raf) { cancelAnimationFrame(raf); raf = null; } last = 0; }
    function frame(now) {
      if (!last) last = now;
      var dt = Math.min(120, Math.max(8, now - last)); last = now;
      rep = true;
      vZoomHold(dir, dt);
      raf = requestAnimationFrame(frame);
    }
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      zoomHoldT.in = zoomHoldT.out = null;               /* a fresh step is not a continuation */
      if (rep) { rep = false; return; }
      fn();
    });
    btn.addEventListener("pointerdown", function () {
      stopHold(); rep = false;
      zoomHoldT.in = zoomHoldT.out = null;
      t = setTimeout(function () { t = null; raf = requestAnimationFrame(frame); }, 260);
    });
    ["pointerup", "pointerleave", "pointercancel", "blur"].forEach(function (ev) { btn.addEventListener(ev, stopHold); });
  }
  bindZoomHold("#btnIn", vZoomIn, 1);
  bindZoomHold("#btnOut", vZoomOut, -1);
  $("#btnHome").addEventListener("click", vHome);
  var deb = null;
  $("#q").addEventListener("input", function () {
    WR.filters.state.q = $("#q").value.trim().toLowerCase();
    clearTimeout(deb); deb = setTimeout(refreshWorld, 180);
    writeHash();
  });
  $("#q").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("#q").blur(); foldPhone(); } });
  $("#btnFold").addEventListener("click", function () { setFold(!foldActive()); });
  function syncPlayableUI() {
    var on = !!WR.filters.state.playOnly, b = $("#btnPlayable");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.textContent = "";
    var sw = document.createElement("span"); sw.className = "sw"; sw.setAttribute("aria-hidden", "true");
    b.appendChild(sw); b.appendChild(document.createTextNode("Verified"));
    b.title = on
      ? "Verified: only stations this browser can play are mapped (" + WR.fmt(WR.data.unplayableCount()) + " hidden — click to show every station)"
      : "Showing every station, including ones this browser can't play — click to map only the verified ones";
  }
  $("#btnPlayable").addEventListener("click", function () {
    var st = WR.filters.state;
    st.playOnly = !st.playOnly; WR.ls.set("playonly", st.playOnly);
    syncPlayableUI(); refreshWorld();
    toast(st.playOnly ? "Verified: showing only stations this browser can play." : "Showing every station — some can't play in this browser.", 5200);
  });

  /* ---- the map credits (2026-10-14): the license line was a permanent text chip - on every
     format it is now a one-tap glyph so no corner is spent on the full block; the complete
     credit text stays on the page (aria-linked, for screen readers) and the compact form is
     the shape these imagery/data licenses expect on busy maps. Tap toggles; a click outside
     or Esc closes. ---- */
  var creditsBtn = $("#attrib"), creditsBody = $("#attribBody");
  function creditsOpen() { return !!(creditsBody && !creditsBody.hidden); }
  function setCredits(open) {
    if (!creditsBtn || !creditsBody) return;
    creditsBody.hidden = !open;
    creditsBtn.classList.toggle("open", open);
    creditsBtn.setAttribute("aria-expanded", String(open));
    creditsBtn.title = open ? "Hide the map credits" : "Map imagery & data credits";
  }
  if (creditsBtn && creditsBody) {
    creditsBtn.addEventListener("click", function (e) { e.stopPropagation(); setCredits(!creditsOpen()); });
    document.addEventListener("click", function (e) {
      if (creditsOpen() && !creditsBtn.contains(e.target) && !creditsBody.contains(e.target)) setCredits(false);
    });
  }

  /* ================== filters, fly-to-results, random flight, deep links ==================
     Parity with the stations list: Format / Bitrate / Country and Saved-only drive the same
     WR.filters.state the list uses, so every control prunes the globe live. ◎ flies to the
     centroid of whatever the filters point at; 🎲 flies somewhere and tunes it in; #q= / #cc=
     / #st= make a view shareable — #st flies to that station, opens its drawer and leaves it
     ready to play (never autoplays: a deep link has no user gesture to spend). */
  function populateFilters() {
    var sc = $("#selCountry"), xc = $("#selCodec");
    if (sc && !sc.dataset.filled) {
      sc.dataset.filled = "1";
      (WR.data.META.countries || []).forEach(function (c) {
        sc.insertAdjacentHTML("beforeend", '<option value="' + WR.esc(c.cc) + '">' + WR.flag(c.cc) + " " + WR.esc(c.c) + " (" + WR.fmt(c.n) + ")</option>");
      });
    }
    if (xc && !xc.dataset.filled) {
      xc.dataset.filled = "1";
      (WR.data.META.codecs || []).slice(0, 12).forEach(function (x) {
        xc.insertAdjacentHTML("beforeend", '<option value="' + WR.esc(x.x) + '">' + WR.esc(x.x) + " (" + WR.fmt(x.n) + ")</option>");
      });
    }
  }
  function syncFilterUI() {
    $("#selCodec").value = WR.filters.state.codec || "";
    $("#selBit").value = String(WR.filters.state.bit || 0);
    $("#selCountry").value = WR.filters.state.cc || "";
  }
  function syncSavedUI() {
    var n = WR.fav.size(), on = !!WR.filters.state.favOnly, b = $("#btnSavedOnly");
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    $("#savedLbl").textContent = "★ Saved" + (n ? " (" + n + ")" : "");
    b.title = on ? "Showing only your saved stations — click to map everything again"
                 : "Saved only: map just the stations you kept (" + n + " saved)";
  }
  function updateFlyBtn() {
    var st = WR.filters.state;
    $("#btnFly").hidden = !((st.q || st.cc || st.codec || st.bit || st.favOnly || (st.tags && st.tags.length)) && wpts.length > 0);
  }
  function zoomNow() {
    if (engine === "maplibre" && mapReady) return map.getZoom();
    if (engine === "canvas" && cvReady) return GlobeView.state().zoom;
    return 2.2;
  }
  $("#btnFly").addEventListener("click", function () {
    if (!worldCentroid) return;
    vFly(worldCentroid.lo, worldCentroid.la, Math.max(2.2, zoomNow()), 1000);
  });
  function flyRandom() {
    var pool = wpts.filter(function (p) { return p.pk; });
    var arr = pool.length ? pool : wpts;
    if (!arr.length) { toast("Nothing to fly to — loosen the filters first.", 5000); return; }
    var p = arr[Math.floor(Math.random() * arr.length)];
    var s = WR.data.all()[p.i]; if (!s) return;
    var fired = false;
    vFly(p.lo, p.la, 3.4, 950, function () {
      if (fired) return; fired = true;
      toast("🎲 " + s.n, 4200); doPlay(s);
    });
  }
  $("#btnRand").addEventListener("click", flyRandom);
  $("#selCodec").addEventListener("change", function () { WR.filters.state.codec = this.value; refreshWorld(); writeHash(); });
  $("#selBit").addEventListener("change", function () { WR.filters.state.bit = +this.value || 0; refreshWorld(); writeHash(); });
  $("#selCountry").addEventListener("change", function () { WR.filters.state.cc = this.value; refreshWorld(); writeHash(); });
  $("#btnSavedOnly").addEventListener("click", function () {
    var st = WR.filters.state;
    st.favOnly = !st.favOnly;
    if (st.favOnly && !WR.fav.size()) toast("Nothing saved yet — ★ a station from its drawer to keep it here.", 5200);
    syncSavedUI(); refreshWorld();
  });

  /* ---- deep links: world.html#q=…  #cc=DE  #st=<uuid> ---- */
  var pendingSt = null, appliedSt = "", hashT = null;
  function readHash() {
    var h = null; try { h = new URLSearchParams(location.hash.slice(1)); } catch (e) { return; }
    if (h.get("q") != null) WR.filters.state.q = String(h.get("q")).trim().toLowerCase();
    if (h.get("cc") != null) {
      var cc = String(h.get("cc")).toUpperCase(), sel = $("#selCountry");
      if (!cc || (sel && sel.querySelector('option[value="' + cc.replace(/"/g, "") + '"]'))) WR.filters.state.cc = cc;
    }
    if (h.get("t") != null) WR.filters.state.tags = String(h.get("t")).split(",").filter(Boolean);
    if (h.get("st") && String(h.get("st")) !== appliedSt) pendingSt = String(h.get("st"));
    syncFilterUI();
    syncChannelsUI();
    $("#q").value = WR.filters.state.q;
    applyPendingSt();
  }
  function applyPendingSt() {
    if (!pendingSt) return;
    if (!(engine === "maplibre" ? mapReady : (engine === "canvas" ? cvReady : false))) return;   // the ready handlers call this again
    var want = pendingSt; pendingSt = null; appliedSt = want;
    var all = WR.data.all(), i = -1;
    for (var k = 0; k < all.length; k++) if (all[k] && all[k].i === want) { i = k; break; }
    if (i < 0) { toast("That station link is not in the catalogue.", 5200); return; }
    var s = all[i], g = geoOf(s, i, all.length - WR.data.ALL.length);
    function ready() {
      openPlace(i, g ? g[0] : null, g ? g[1] : null);
      WR.play.setStation(WR.play.M(s));      // loaded, drawer open — ready to play, not auto-playing
    }
    if (!g) { ready(); return; }
    var fired = false;
    vFly(g[1], g[0], Math.max(3.4, zoomNow()), 1100, function () { if (fired) return; fired = true; ready(); });
  }
  function hashString() {
    var h = new URLSearchParams(), st = WR.filters.state;
    if (st.q) h.set("q", st.q);
    if (st.cc) h.set("cc", st.cc);
    if (st.tags && st.tags.length) h.set("t", st.tags.join(","));
    if (lastPlace) { var s = WR.data.all()[lastPlace.i]; if (s && s.i) h.set("st", s.i); }
    return h.toString();
  }
  function writeHash() {
    clearTimeout(hashT);
    hashT = setTimeout(function () {
      /* replaceState throws on the app's file:// origin — a lost hash must never break the page */
      try { history.replaceState(null, "", "#" + hashString()); } catch (e) {}
    }, 300);
  }
  window.addEventListener("hashchange", function () { readHash(); refreshWorld(); });
  function syncTopH() {
    var tb = document.querySelector(".topbar");
    var top = 0;
    if (tb) { top = Math.round(tb.getBoundingClientRect().bottom); document.documentElement.style.setProperty("--topH", top + "px"); }
    /* the count chip's measured height parks the phone tool row under it on narrow AND short
       screens (the combined media block reads --ctlTop; see the retractable-bar note below) */
    var cc = document.getElementById("countChip");
    var chipH = cc ? Math.round(cc.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--chipH", chipH + "px");
    document.documentElement.style.setProperty("--ctlTop", (top + 2 + chipH + 6) + "px");
    /* the transport bar anchors every bottom chip - measured, so an iPhone's safe-area inset
       (a taller bar) can never leave a chip underneath it */
    var tbr = document.getElementById("tbar");
    if (tbr) document.documentElement.style.setProperty("--tbarH", Math.round(tbr.getBoundingClientRect().height) + "px");
  }
  window.addEventListener("resize", function () { applyFold(); syncTopH(); });

  /* ---- the retractable phone bar (2026-10-14) ----
     On a phone (≤720px) the top bar folds to a single row so the globe is never buried behind
     the search, filters and channels; the ▾ button unfolds it. The choice sticks per device
     (rbg "foldtop"); the fold never applies above 720px; folding re-measures the chrome, so
     every floating chip follows. An applied search (Enter) or a channel tap folds it back. */
  function narrowTop() { try { return matchMedia("(max-width: 720px)").matches; } catch (e) { return window.innerWidth <= 720; } }
  function foldStored() { var v = WR.ls.get("foldtop", null); return v === null ? null : !!v; }
  function foldActive() { return document.body.classList.contains("foldtop"); }
  function applyFold() {
    var f = narrowTop() && foldStored() !== false;
    document.body.classList.toggle("foldtop", f);
    var b = $("#btnFold");
    if (b) {
      b.textContent = f ? "▾" : "▴";
      b.title = f ? "Show the search, filters and channels" : "Hide the search, filters and channels";
      b.setAttribute("aria-label", f ? "Show the search and filters" : "Hide the search and filters");
      b.setAttribute("aria-expanded", f ? "false" : "true");
    }
  }
  function setFold(f) { WR.ls.set("foldtop", !!f); applyFold(); syncTopH(); }
  function foldPhone() { if (narrowTop()) setFold(true); }

  /* ================ S3a: the out-do layers, the keyboard set, share, the viz strip ================
     Day/night terminator (client-side NOAA-style approximation — a visual cue, imagery is never
     swapped), a density heatmap, saved + recently-played layers, arrow-key panning, r for a random
     flight, h for home, l/Esc back to the list, a share button that copies the exact view link, and
     viz.js on the transport (the same five looks as index, the same rbg-viz setting). */
  function localTimeAt(lon) {
    var t = new Date(Date.now() + lon * 240000);   // solar time: the sun is 4 minutes per degree away
    var h = t.getUTCHours(), m = t.getUTCMinutes(), ap = h >= 12 ? "pm" : "am", h12 = h % 12 || 12;
    return h12 + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }

  var layers = {
    day: WR.ls.get("globe-day", true) !== false,
    heat: !!WR.ls.get("heat", false),
    saved: !!WR.ls.get("ly-saved", false),
    recent: !!WR.ls.get("ly-recent", false)
  };
  var layersOpen = false, savedN = 0, recentN = 0, termTimer = null;

  /* --- the terminator (the wfd-proven solar approximation, adapted) --- */
  function subsolarPoint(ms) {
    var n = ms / 86400000 + 2440587.5 - 2451545.0;             // days since J2000
    var L = (280.460 + 0.9856474 * n) % 360;                   // mean longitude, deg
    var g = ((357.528 + 0.9856003 * n) % 360) * RAD;           // mean anomaly, rad
    var lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    var eps = (23.439 - 0.0000004 * n) * RAD;                  // obliquity, rad
    var dec = Math.asin(Math.sin(eps) * Math.sin(lam));        // solar declination, rad
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    var gmst = 280.46061837 + 360.98564736629 * n;             // GMST, deg
    var lng = (ra * R2D - gmst) % 360;
    if (lng > 180) lng -= 360;
    if (lng < -180) lng += 360;
    return { lat: dec * R2D, lng: lng };
  }
  function terminatorData(ms) {
    var sub = subsolarPoint(ms), dec = sub.lat * RAD;
    var darkPole = sub.lat >= 0 ? -89.5 : 89.5;                // the pole that is in darkness
    var ring = [], line = [];
    for (var lon = -180; lon <= 180; lon += 2) {
      var h = (lon - sub.lng) * RAD;                           // hour angle, rad
      var phi = Math.atan2(-Math.cos(h) * Math.cos(dec), Math.sin(dec)) * R2D;
      if (phi > 90) phi -= 180;                                // fold into (-90, 90]
      if (phi <= -90) phi += 180;
      ring.push([lon, phi]); line.push([lon, phi]);
    }
    ring.push([180, darkPole], [-180, darkPole], ring[0]);
    return {
      fill: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
      line: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } }
    };
  }
  function ensureTerm() {
    if (!(engine === "maplibre" && mapReady)) return;
    var d = terminatorData(Date.now());
    if (!map.getSource("wr-night")) {
      map.addSource("wr-night", { type: "geojson", data: d.fill });
      map.addSource("wr-night-line", { type: "geojson", data: d.line });
      /* above the imagery, below every dot */
      map.addLayer({ id: "wr-night-fill", type: "fill", source: "wr-night",
        paint: { "fill-color": "#040a18", "fill-opacity": 0.45 } }, "wr-clusters-glow");
      map.addLayer({ id: "wr-night-line", type: "line", source: "wr-night-line",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#bfeaff", "line-width": 1.5, "line-opacity": 0.5, "line-blur": 2.2 } }, "wr-clusters-glow");
    } else {
      map.getSource("wr-night").setData(d.fill);
      map.getSource("wr-night-line").setData(d.line);
    }
  }
  function dropTerm() {
    if (engine === "maplibre" && mapReady) {
      ["wr-night-line", "wr-night-fill"].forEach(function (id) { try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) {} });
      ["wr-night-line", "wr-night"].forEach(function (id) { try { if (map.getSource(id)) map.removeSource(id); } catch (e) {} });
    }
  }
  function setTermState(on) {
    clearInterval(termTimer); termTimer = null;
    if (on) { ensureTerm(); termTimer = setInterval(ensureTerm, 60000); }   // the sun keeps moving
    else dropTerm();
  }

  /* --- the saved + recently-played layers (uuid -> coordinates, no cached copy of the catalogue) --- */
  function geoForUuids(uuids) {
    var out = {}, want = {}, k = 0, i;
    for (i = 0; i < uuids.length; i++) if (uuids[i] && !want[uuids[i]]) { want[uuids[i]] = 1; k++; }
    if (!k) return out;
    var all = WR.data.all(), ccOff = all.length - WR.data.ALL.length;
    for (i = 0; i < all.length && k; i++) {
      var s = all[i]; if (!s || !want[s.i]) continue;
      var g = geoOf(s, i, ccOff);
      if (g) out[s.i] = g;
      delete want[s.i]; k--;
    }
    return out;
  }
  function fcFromUuids(uuids) {
    var geo = geoForUuids(uuids), feats = [];
    uuids.forEach(function (u) {
      var g = geo[u]; if (!g) return;
      feats.push({ type: "Feature", properties: {},
        geometry: { type: "Point", coordinates: [Math.round(g[1] * 1e6) / 1e6, Math.round(g[0] * 1e6) / 1e6] } });
    });
    return { type: "FeatureCollection", features: feats };
  }
  function refreshSavedLayer() {
    if (!(engine === "maplibre" && mapReady)) return;
    var src = map.getSource("wr-saved"); if (!src) return;
    var fc = fcFromUuids(WR.fav.list());
    savedN = fc.features.length; src.setData(fc);
  }
  function refreshRecentLayer() {
    if (!(engine === "maplibre" && mapReady)) return;
    var src = map.getSource("wr-recent"); if (!src) return;
    var fc = fcFromUuids(WR.recents.list());
    recentN = fc.features.length; src.setData(fc);
  }
  function visLayer(id, on) { try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); } catch (e) {} }
  function mpRows(on) {
    [].forEach.call(document.querySelectorAll(".lp-mp"), function (el) { el.style.display = on ? "flex" : "none"; });
  }
  function syncLayersUI() {
    [["lyDay", layers.day], ["lyHeat", layers.heat], ["lySaved", layers.saved], ["lyRecent", layers.recent]]
      .forEach(function (p) {
        var el = document.getElementById(p[0]); if (!el) return;
        el.classList.toggle("on", !!p[1]); el.setAttribute("aria-pressed", String(!!p[1]));
      });
    var b = $("#btnLayers"); if (b) b.setAttribute("aria-expanded", String(layersOpen));
  }
  function setLayersOpen(on) {
    layersOpen = !!on;
    $("#layersPanel").hidden = !layersOpen;
    var b = $("#btnLayers");
    if (b) { b.classList.toggle("on", layersOpen); b.setAttribute("aria-expanded", String(layersOpen)); }
    if (layersOpen) closePlace();
  }
  function applyLayers() {
    if (engine === "maplibre" && mapReady) {
      setTermState(layers.day);
      visLayer("wr-heat", layers.heat);
      if (layers.heat && lastData) { var hs = map.getSource("wr-heat"); if (hs) hs.setData(buildFC(lastData.pts)); }
      visLayer("wr-saved-dots", layers.saved); if (layers.saved) refreshSavedLayer();
      visLayer("wr-recent-dots", layers.recent); if (layers.recent) refreshRecentLayer();
      mpRows(true);
    } else if (engine === "canvas" && cvReady) {
      GlobeView.setTerminator(layers.day);
      mpRows(false);
    }
    syncLayersUI();
  }
  $("#btnLayers").addEventListener("click", function () { setLayersOpen(!layersOpen); });
  $("#layersClose").addEventListener("click", function () { setLayersOpen(false); });
  $("#lyDay").addEventListener("click", function () {
    layers.day = !layers.day; WR.ls.set("globe-day", layers.day);
    if (engine === "maplibre" && mapReady) setTermState(layers.day);
    else if (engine === "canvas" && cvReady) GlobeView.setTerminator(layers.day);
    syncLayersUI();
  });
  $("#lyHeat").addEventListener("click", function () {
    layers.heat = !layers.heat; WR.ls.set("heat", layers.heat);
    if (engine === "maplibre" && mapReady) {
      visLayer("wr-heat", layers.heat);
      if (layers.heat && lastData) { var hs = map.getSource("wr-heat"); if (hs) hs.setData(buildFC(lastData.pts)); }
    }
    syncLayersUI();
  });
  $("#lySaved").addEventListener("click", function () {
    layers.saved = !layers.saved; WR.ls.set("ly-saved", layers.saved);
    if (engine === "maplibre" && mapReady) { visLayer("wr-saved-dots", layers.saved); if (layers.saved) refreshSavedLayer(); }
    syncLayersUI();
  });
  $("#lyRecent").addEventListener("click", function () {
    layers.recent = !layers.recent; WR.ls.set("ly-recent", layers.recent);
    if (engine === "maplibre" && mapReady) { visLayer("wr-recent-dots", layers.recent); if (layers.recent) refreshRecentLayer(); }
    syncLayersUI();
  });

  /* ---- share: copy a link that reopens this exact view ---- */
  $("#btnShare").addEventListener("click", function () {
    try { history.replaceState(null, "", "#" + hashString()); } catch (e) {}
    WR.copyText(location.href, "View link");
  });

  /* ---- the keyboard pan helper (centre math, so both engines agree on direction) ---- */
  function panView(dLon, dLat) {
    if (engine === "maplibre" && mapReady) {
      var c = map.getCenter();
      map.easeTo({ center: [wrapLng(c.lng + dLon), Math.max(-85, Math.min(85, c.lat + dLat))], duration: 260 });
    } else if (engine === "canvas" && cvReady) GlobeView.nudge(dLon, dLat);
  }

  /* ---- offline honesty: imagery cannot load with no connection — say it, and say when it's back ---- */
  var offlineShown = false;
  window.addEventListener("offline", function () {
    offlineShown = true;
    notice("📡 You look offline — the map imagery can't load until the connection is back. The stations already on screen stay clickable.", "warn");
  });
  window.addEventListener("online", function () {
    if (!offlineShown) return;
    offlineShown = false;
    var bar = $("#notice");
    if (bar && bar.className.indexOf("show") !== -1) bar.className = "";
    toast("Back online — imagery resumes.", 3800);
  });

  /* ---- the visualiser strip on the transport (viz.js — the same looks index draws) ---- */
  var vc = $("#tViz"), vctx2 = vc ? vc.getContext("2d") : null;
  var VIZSTYLES = (window.Viz ? window.Viz.STYLES : ["bars", "waves", "mirror", "dots", "blocks"]);
  var VIZREDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var vizOn = false, vizStyle = 0, vizLevels = new Array(56).fill(0), vizLast = 0;
  function vizSize() {
    if (!vc) return;
    var r = vc.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    vc.width = Math.max(120, Math.round((r.width || 300) * dpr));
    vc.height = Math.max(24, Math.round((r.height || 44) * dpr));
  }
  function vizSet(on, st2) {
    vizOn = !!on; vizStyle = st2 || 0; WR.ls.set("viz", vizOn ? vizStyle + 1 : 0);
    if (vc) vc.style.display = vizOn ? "block" : "none";
    var b = $("#tVizBtn");
    if (b) { b.classList.toggle("pop", vizOn); b.title = "Visualiser: " + (vizOn ? VIZSTYLES[vizStyle] : "off") + " — click to cycle 5 styles"; }
    if (vizOn) vizSize();
  }
  function vizNext() {
    if (!vizOn) vizSet(true, 0);
    else if (vizStyle < VIZSTYLES.length - 1) vizSet(true, vizStyle + 1);
    else vizSet(false, 0);
  }
  if ($("#tVizBtn")) $("#tVizBtn").addEventListener("click", vizNext);
  window.addEventListener("resize", function () { if (vizOn) vizSize(); });
  function vizLoop(t) {
    requestAnimationFrame(vizLoop);
    if (!vizOn || document.hidden || !vctx2) { vizLast = t; return; }
    var dt = Math.min(0.05, ((t - vizLast) / 1000) || 0.016); vizLast = t;
    var act = (WR.play.playing() ? (WR.play.mine() ? 1 : 0.55) : 0.18) * (VIZREDUCED ? 0.45 : 1);
    if (window.Viz) { window.Viz.step(vizLevels, dt, act, VIZREDUCED, t / 1000); window.Viz.draw(vctx2, vc.width, vc.height, vizLevels, vizStyle); }
    else vctx2.clearRect(0, 0, vc.width, vc.height);
  }
  if (vc) { vizSize(); requestAnimationFrame(vizLoop); }
  var vizRestore = WR.ls.get("viz", 0);
  if (vizRestore > 0) vizSet(true, Math.min(vizRestore - 1, VIZSTYLES.length - 1));

  /* ---- the ambient globe visualiser (S3c): quiet space around the planet -----------------
     A full-viewport canvas between the map and the chrome (globeviz.js paints it): ten subtle
     looks, a few of them space-based, drawn around the globe disc and never over the map. One
     tap on ✨ cycles them and the choice persists (rbg-globe-viz); the intensity follows the
     playback state the way the transport visualiser does. Under reduced motion it is a still
     frame, painted once per change. */
  var gvc = $("#gViz"), gvctx = gvc ? gvc.getContext("2d") : null;
  var GVSTYLES = (window.GViz && window.GViz.STYLES) || ["stars", "nebula", "aurora", "orbits", "constellations", "ripples", "comets", "motes", "pulse", "scan"];
  var gvOn = false, gvStyle = 0, gvT0 = 0;
  function gvSize() {
    if (!gvc || !gvctx) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = gvc.clientWidth || window.innerWidth, H = gvc.clientHeight || window.innerHeight;
    gvc.width = Math.max(320, Math.round(W * dpr)); gvc.height = Math.max(240, Math.round(H * dpr));
    gvctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function gvGeo() {
    var W = gvc.clientWidth || window.innerWidth, H = gvc.clientHeight || window.innerHeight;
    var z = zoomNow(), r = (engine === "canvas" && cvReady && window.GlobeView)
      ? Math.min(W, H) * 0.42 * z                                        // globe.js: R = min(W,H)*0.42*zoom
      : 256 * Math.pow(2, z) / Math.PI;                                  // maplibre: diameter 512*2^z/pi
    return { cx: W / 2, cy: H / 2, r: Math.max(60, r) };
  }
  function gvFrame(t) {
    if (!gvctx || !window.GViz) return;
    var W = gvc.clientWidth || window.innerWidth, H = gvc.clientHeight || window.innerHeight;
    var act = WR.play.playing() ? (WR.play.mine() ? 1 : 0.55) : 0.18;    // the same aliveness the strip uses
    window.GViz.draw(gvctx, W, H, gvStyle, (WR.REDUCED && gvStyle !== GVGARDEN) ? 7 : (t - gvT0) / 1000, act, (WR.REDUCED && gvStyle !== GVGARDEN), gvGeo());
  }
  function gvLoop(t) {
    requestAnimationFrame(gvLoop);
    if (!gvOn || document.hidden || !gvctx || !window.GViz || (WR.REDUCED && gvStyle !== GVGARDEN)) return;   /* the garden is user-driven: it stays live even under reduced motion */
    if (!gvT0) gvT0 = t;
    gvFrame(t);
  }
  function gvSet(on, st) {
    gvOn = !!on; gvStyle = st || 0;
    WR.ls.set("globe-viz", gvOn ? gvStyle + 1 : 0);
    if (gvc) gvc.classList.toggle("on", gvOn);
    var b = $("#btnGViz");
    if (b) {
      b.classList.toggle("on", gvOn);
      b.setAttribute("aria-pressed", String(gvOn));
      b.title = "Ambient visualiser: " + (gvOn ? GVSTYLES[gvStyle] : "off") + " — click to cycle " + GVSTYLES.length + " styles";
    }
    if (gvOn) { gvSize(); if (WR.REDUCED) gvFrame(0); }
  }
  function gvNext() {
    if (!GVSTYLES.length) return;
    if (!gvOn) gvSet(true, 0);
    else if (gvStyle < GVSTYLES.length - 1) gvSet(true, gvStyle + 1);
    else gvSet(false, 0);
  }
  if ($("#btnGViz")) $("#btnGViz").addEventListener("click", gvNext);
  window.addEventListener("resize", function () { if (gvOn) { gvSize(); if (WR.REDUCED) gvFrame(0); } });
  if (gvc) { gvSize(); requestAnimationFrame(gvLoop); }
  var GVGARDEN = GVSTYLES.indexOf("garden");
  function gvPointer(e) {                              /* the garden moves with the pointer; the other looks are ambient */
    if (gvOn && gvStyle === GVGARDEN && GVGARDEN >= 0 && window.GViz && GViz.ptr) GViz.ptr(e.clientX, e.clientY);
  }
  window.addEventListener("pointermove", gvPointer, { passive: true });
  window.addEventListener("pointerdown", gvPointer, { passive: true });
  var gvRestore = WR.ls.get("globe-viz", null);
  if (gvRestore > 0) gvSet(true, Math.min(gvRestore - 1, GVSTYLES.length - 1));
  else if (gvRestore === null) gvSet(true, 0);   /* a first visit lands under a glistening night sky (stars) */

  /* ---- S3b: the channels rail — the catalogue's curated top tags as one-tap filters ---- */
  function populateChannels() {
    var el = $("#channels");
    if (!el || el.dataset.filled) return;
    el.dataset.filled = "1";
    (WR.data.META.topTags || []).slice(0, 10).forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "chk"; b.dataset.tag = t.t;
      b.textContent = t.t; b.title = WR.fmt(t.n) + " stations tagged “" + t.t + "” — one tap filters the globe";
      el.appendChild(b);
    });
    el.addEventListener("click", function (e) {
      var c = e.target.closest(".chk"); if (!c) return;
      var tag = c.dataset.tag, st = WR.filters.state;
      st.tags = (st.tags.length === 1 && st.tags[0] === tag) ? [] : [tag];
      syncChannelsUI(); refreshWorld(); writeHash(); foldPhone();
    });
  }
  function syncChannelsUI() {
    var st = WR.filters.state;
    [].forEach.call(document.querySelectorAll("#channels .chk"), function (c) {
      c.classList.toggle("on", st.tags.length === 1 && st.tags[0] === c.dataset.tag);
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (creditsOpen()) { setCredits(false); return; }
      if (layersOpen) { setLayersOpen(false); return; }
      if (placePanelOpen()) { closePlace(); return; }
      if ($("#modal").style.display === "flex") { $("#modal").style.display = "none"; return; }
      var tt = e.target;
      if (tt && (tt.tagName === "INPUT" || tt.tagName === "TEXTAREA")) return;   // let the search box clear itself
      location.href = "index.html";       /* nothing to close: Esc backs out to the list */
      return;
    }
    var t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "+" || e.key === "=") vZoomIn();
    else if (e.key === "-" || e.key === "_") vZoomOut();
    else if (e.key === "r" || e.key === "R") flyRandom();
    else if (e.key === "h" || e.key === "H") vHome();
    else if (e.key === "l" || e.key === "L") location.href = "index.html";
    else if (e.key === "v" || e.key === "V") vizNext();
    else if (e.key === "u" || e.key === "U") {
      if (unmappedListOpen()) closePlace();
      else if (lastUnmapped.length) openUnmapped();
      else toast("Every station in this search has coordinates — nothing to list here.", 4200);
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); panView(-6, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); panView(6, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); panView(0, 4); }
    else if (e.key === "ArrowDown") { e.preventDefault(); panView(0, -4); }
  });

  /* ============================== probes ============================== */
  /* firstDot([hx, hy, rad]): screen coords of a dot (or, failing that, a cluster)
     that is really rendered, not covered by a chip or a country label, and on the
     near face of the globe — a click outside the disc hit-tests the far hemisphere
     and is ignored (farSide), so the drill must never aim there. The optional
     hint scans a
     fine grid around (hx, hy) first — after a cluster click the map centres on
     the expanded cluster, so its children are near the canvas centre and the
     coarse grid can miss them. */
  function firstDot(hx, hy, rad) {
    if (engine === "maplibre" && mapReady) {
      var cv = map.getCanvas(), W = cv.clientWidth, H = cv.clientHeight;
      var rect = cv.getBoundingClientRect();
      var gg = gvGeo();               /* the disc: cx/cy/r at the current zoom */
      function scan(x0, y0, x1, y1, step, layers) {
        x0 = Math.max(2, x0); y0 = Math.max(2, y0);
        x1 = Math.min(W - 2, x1); y1 = Math.min(H - 2, y1);
        for (var y = y0; y <= y1; y += step) {
          for (var x = x0; x <= x1; x += step) {
            if (Math.hypot(x - gg.cx, y - gg.cy) > gg.r * 1.02) continue;   /* far hemisphere — a click there is dropped */
            var f = map.queryRenderedFeatures([x, y], { layers: layers });
            if (!f || !f.length) continue;
            if (document.elementFromPoint(rect.left + x, rect.top + y) !== cv) continue;
            /* S3b-2: a cluster under a country label opens the explore list instead of
               zooming — the drill must not aim there (a station dot keeps its click). */
            if (layers === CLUSTER_LAYERS && map.queryRenderedFeatures([x, y], { layers: ["wr-country-labels"] }).length) continue;
            return { x: Math.round(x), y: Math.round(y), f: f[0] };
          }
        }
        return null;
      }
      var hit = null;
      if (typeof hx === "number" && typeof hy === "number") hit = scan(hx - rad, hy - rad, hx + rad, hy + rad, 8, POINT_LAYERS);
      if (!hit) hit = scan(0, 0, W, H, Math.round(W / 20), POINT_LAYERS);
      if (hit) {
        var s = WR.data.all()[hit.f.properties.i | 0] || {};
        return { kind: "point", x: hit.x, y: hit.y, name: s.n || "", i: hit.f.properties.i | 0 };
      }
      if (typeof hx === "number" && typeof hy === "number") hit = scan(hx - rad, hy - rad, hx + rad, hy + rad, 8, CLUSTER_LAYERS);
      if (!hit) hit = scan(0, 0, W, H, Math.round(W / 20), CLUSTER_LAYERS);
      if (hit) return { kind: "cluster", x: hit.x, y: hit.y, count: hit.f.properties.point_count | 0 };
      return null;
    }
    if (engine === "canvas" && cvReady && window.GlobeView) {
      var c2 = $("#globe"), r2 = c2.getBoundingClientRect();
      var nX = 26, nY = 20;
      /* two passes like the MapLibre branch: singles anywhere on the grid win over the
         first cluster found (the first hit is almost always a cluster — they cover the
         world at low zoom — and a scan that stops there can never reach a dot). */
      var clusterHit = null;
      for (var jj = 0; jj < nY; jj++) {
        for (var ii = 0; ii < nX; ii++) {
          var xx = Math.round((ii + 0.5) * r2.width / nX), yy = Math.round((jj + 0.5) * r2.height / nY);
          var p = GlobeView.hitAt(xx, yy);
          if (!p) continue;
          if (document.elementFromPoint(r2.left + xx, r2.top + yy) !== c2) continue;
          if (p.n === 1) {
            var st = WR.data.all()[p.idxs[0]] || {};
            return { kind: "point", x: xx, y: yy, name: st.n || "", i: p.idxs[0] };
          }
          if (!clusterHit) clusterHit = { x: xx, y: yy, count: p.n };
        }
      }
      if (clusterHit) return { kind: "cluster", x: clusterHit.x, y: clusterHit.y, count: clusterHit.count };
      return null;
    }
    return null;
  }

  window.__dbg = {
    ALL: function () { return (window.RB_STATIONS || []).length; },
    ready: function () { return { catalogue: !!(window.RB_STATIONS && window.RB_STATIONS.length), engine: engine, engineReady: !!(engine === "maplibre" ? mapReady : cvReady), mapReady: !!mapReady, points: lastLocated, shown: lastShown }; },
    state: function () { var st = WR.filters.state; return { q: st.q, playOnly: !!st.playOnly, favOnly: !!st.favOnly, cc: st.cc || "", codec: st.codec || "", bit: st.bit || 0 }; },
    counts: function () { return { located: lastLocated, shown: lastShown, total: WR.data.all().length, unmapped: lastUnmapped.length }; },
    engine: function () { return engine; },
    globe: function () {
      if (engine === "maplibre" && mapReady) {
        var c = map.getCenter();
        var clusters = 0; try { clusters = map.queryRenderedFeatures({ layers: CLUSTER_LAYERS }).length; } catch (e) {}
        return { engine: "maplibre", ready: true, projection: (map.getProjection ? map.getProjection().type : "globe"),
          points: lastLocated, labels: lastLabels, zoom: Math.round(map.getZoom() * 100) / 100,
          lon: Math.round(c.lng * 100) / 100, lat: Math.round(c.lat * 100) / 100,
          spin: spinActive(), marker: nowShown, hover: hoverLabel, clusters: clusters,
          loaded: map.loaded(), centroid: worldCentroid, night: !!map.getLayer("wr-night-fill") };
      }
      if (engine === "canvas" && cvReady) {
        var st = GlobeView.state();
        st.engine = "canvas";
        st.marker = !!st.marker;
        st.centroid = worldCentroid;
        st.night = !!GlobeView.getTerminator();
        return st;
      }
      return { engine: engine, ready: false, points: 0, clusters: 0, labels: 0, zoom: 1, lon: 0, lat: 0, spin: false, marker: false, hover: null };
    },
    firstDot: firstDot,
    labelPoint: function () {
      if (engine !== "maplibre" || !mapReady) return null;
      var cv = map.getCanvas(), W = cv.clientWidth, H = cv.clientHeight, rect = cv.getBoundingClientRect();
      var feats = []; try { feats = map.queryRenderedFeatures({ layers: ["wr-country-labels"] }); } catch (e) { return null; }
      var offs = [[0, 0], [14, 0], [-14, 0], [28, 0], [-28, 0], [42, 0], [-42, 0], [0, -7], [14, -7], [-14, -7], [28, -7], [-28, -7], [0, 7], [14, 7], [-14, 7], [28, 7], [-28, 7], [56, 0], [-56, 0]];
      for (var fi = 0; fi < feats.length; fi++) {
        var fe = feats[fi], pc = fe.geometry && fe.geometry.coordinates; if (!pc) continue;
        var cc = fe.properties && fe.properties.cc; if (!cc) continue;
        var pr = map.project([pc[0], pc[1]]);
        for (var o = 0; o < offs.length; o++) {
          var x = Math.round(pr.x + offs[o][0]), y = Math.round(pr.y + offs[o][1]);
          if (x < 2 || y < 2 || x > W - 2 || y > H - 2) continue;
          var lf = map.queryRenderedFeatures([x, y], { layers: ["wr-country-labels"] });
          if (!lf || !lf.length || !lf[0].properties || lf[0].properties.cc !== cc) continue;
          if (map.queryRenderedFeatures([x, y], { layers: POINT_LAYERS }).length) continue;
          if (document.elementFromPoint(rect.left + x, rect.top + y) !== cv) continue;
          return { x: x, y: y, cc: cc, name: lf[0].properties.label || "" };
        }
      }
      return null;
    },
    explore: function () {
      var rows = [].map.call(document.querySelectorAll("#placeList .prow"), function (r) {
        var nmEl = r.querySelector(".x-n");
        return { p: nmEl ? nmEl.textContent : "", n: parseInt(r.dataset.n, 10) || 0 };
      });
      return { open: placePanelOpen(), cc: exploreCc || "", title: $("#placeTitle").textContent,
        sub: $("#placeSub").textContent, rows: rows, n: rows.length, fly: exploreFly };
    },
    globeHit: function (x, y) {
      if (engine === "maplibre" && mapReady) {
        var f = map.queryRenderedFeatures([+x, +y], { layers: INTERACTIVE });
        if (!f || !f.length) return null;
        var p = f[0].properties;
        return p.cluster_id != null ? { kind: "cluster", n: p.point_count | 0 } : { kind: "point", i: p.i | 0, n: 1 };
      }
      if (engine === "canvas" && cvReady) {
        var h = GlobeView.hitAt(+x, +y); return h ? { kind: h.n === 1 ? "point" : "cluster", i: h.idxs && h.idxs[0], n: h.n } : null;
      }
      return null;
    },
    place: function () { return { open: placePanelOpen(), title: $("#placeTitle").textContent, rows: document.querySelectorAll("#placeList .srow").length }; },
    unmapped: function () { return { open: placePanelOpen() && unmappedOn, count: lastUnmapped.length, rendered: unShown,
      rows: document.querySelectorAll("#placeList .srow").length, title: $("#placeTitle").textContent, sub: $("#placeSub").textContent,
      note: $("#placeNote").hidden ? "" : $("#placeNote").textContent, more: !!document.getElementById("placeMore"), rand: !$("#placeRand").hidden }; },
    player: function () { var cur = WR.play.cur(); return { cur: cur ? cur.n : null, playing: WR.play.playing(), vol: WR.play.vol(), mine: WR.play.mine() }; },
    stream: function () {
      var a = WR.play.audioEl(), o = WR.play.owner();
      return { mine: WR.play.mine(), playing: WR.play.playing(), hasSrc: !!a.src, cur: WR.play.cur() && WR.play.cur().n,
        owner: o ? o.kind : null, vol: WR.play.vol(), primed: WR.play.primed(), err: WR.play.lastErr() };
    },
    fav: function () { return { count: WR.fav.size() }; },
    layers: function () { return { open: layersOpen, day: !!layers.day, heat: !!layers.heat, saved: !!layers.saved, recent: !!layers.recent, savedN: savedN, recentN: recentN, viz: vizOn }; },
    pop: function () { return { open: popOutOpen(), win: !!(winPop && !winPop.closed), alive: popAliveFresh() }; },
    vizG: function () { var fs = (gvOn && window.GViz && GViz.stats) ? GViz.stats() : null; return { on: gvOn, style: gvStyle, name: gvOn ? (GVSTYLES[gvStyle] || "") : "", anim: !!(gvOn && (!WR.REDUCED || gvStyle === GVGARDEN)), flowers: fs ? fs.flowers : 0, doves: fs ? fs.doves : 0 }; },
    channels: function () { var st = WR.filters.state; return { count: document.querySelectorAll("#channels .chk").length, on: (st.tags && st.tags.length === 1) ? st.tags[0] : "" }; },
    fold: function () { return { folded: foldActive(), narrow: narrowTop(), pref: foldStored(), bar: Math.round(document.querySelector(".topbar").getBoundingClientRect().height) }; },
    custom: function () { return { count: WR.data.custom().length, names: WR.data.custom().map(function (s) { return s.n; }) }; },
    errors: function () { return errs; },
    rawMap: function () { return map; }
  };

  /* ============================== the boot ============================== */
  function boot() {
    var sp = document.getElementById("spinN");
    if (sp) sp.textContent = WR.fmt((window.RB_STATIONS || []).length);
    WR.data.refreshCustom();
    syncPlayableUI();
    syncSavedUI();
    populateFilters();
    populateChannels();
    readHash();
    applyFold();
    syncTopH();
    syncLayersUI();
    tbarVol(WR.play.vol());
    var L = WR.ls.get("last", null);
    if (L && L.m) WR.play.setStation(L.m); else tbarStation(null);
    var carry = WR.play.resumePending(); if (carry) WR.play.resumePlay(carry);   /* S3c: the music follows you between pages */
    refreshWorld();
    startEngine();
    WR.chan.post({ type: "hello" });
  }
  boot();
})();
