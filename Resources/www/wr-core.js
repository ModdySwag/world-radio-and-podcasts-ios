/* ============================================================================
   WR — the shared core of MODDYS World Radio's pages.

   One implementation of everything the stations list (index.html) and the World
   View (world.html) both need: the storage helper, the station helpers, the
   capability probe, the search/filter state and matcher, the favourites, the
   user's own stations, the cross-window channel — and the single-owner player
   (exactly ONE window holds the <audio> element; every other window is a remote
   control; the stream hands over, it is never doubled).

   This file was born from index.html's inline script and is moved over verbatim
   wherever the code touched no DOM. The bits that DID touch the page are host
   hooks, so each page renders its own chrome:

       WR.hooks.onStation(m)              a station became current   (name / art / meta)
       WR.hooks.onPlaying(on, info)       the play state changed     (info: {mine, remoteKind})
       WR.hooks.onVol(vol)                the volume changed
       WR.hooks.onFavs()                  the saved list changed
       WR.hooks.toast(msg, ms)            a transient message
       WR.hooks.toastAction(msg, label, fn, ms)  a toast with one button (the carry-over resume offer)
       WR.hooks.notice(html, kind, opts)  a persistent notice bar    (opts.tryAgain wired by host)

   A hook left null is silence, never a crash.

   Timeline: S1 of the World View v2 project — only world.html loads this file.
   index.html still carries its own inline copy and switches to WR (with its own
   hooks) in S2, verified by the existing suites at unchanged counts.
   ============================================================================ */
window.WR = (function () {
  "use strict";

  var META = window.RB_META || { countries: [] };
  var ALL = window.RB_STATIONS || [];

  /* ============================= helpers ============================= */
  var ls = {
    get: function (k, d) { try { var v = localStorage.getItem("rbg-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("rbg-" + k, JSON.stringify(v)); } catch (e) {} }
  };
  var fmt = function (n) { return (n == null ? 0 : n).toLocaleString(); };
  var esc = function (x) { return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
  var flag = function (cc) { return cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); }) : "🌐"; };
  var tokens = function (t) { return (t || "").split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean); };
  var normLang = function (l) { return (l || "").trim().toLowerCase(); };
  var ccName = {}; (META.countries || []).forEach(function (c) { ccName[c.cc] = c.c; });
  var countryOf = function (s) { return (s.cc && ccName[s.cc]) || s.c || "Unknown"; };
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  function copyText(txt, label) {
    var done = function () { say((label || "Stream URL") + " copied."); };
    var legacy = function () {
      var ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { say("Copy failed."); }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done).catch(legacy);
    else legacy();
  }

  /* ================== environment detection ==================
     Old browsers, private mode, blocked pop-ups, missing APIs: every failure
     becomes a visible message, never silence. (Pop-up/fs probes stay per-page.) */
  var CAP = (function () {
    var storage = false, bc = false, hls = false, audio = false;
    try { localStorage.setItem("rbg-t", "1"); localStorage.removeItem("rbg-t"); storage = true; } catch (e) { storage = false; }
    try { bc = !!window.BroadcastChannel; } catch (e) { bc = false; }
    try {
      var a = new Audio(); audio = typeof a.play === "function";
      /* canPlayType alone lies here: desktop Chrome/Edge answer "maybe" for HLS without being
         able to play it. Only Safari (all platforms) and Chrome/Edge on Android really demux HLS. */
      var claims = !!(a.canPlayType && a.canPlayType("application/vnd.apple.mpegurl"));
      var vendor = (navigator.vendor || ""), ua = (navigator.userAgent || "");
      hls = claims && (/Apple/.test(vendor) || /Android/i.test(ua));
    } catch (e) {}
    var legacy = !(window.fetch && window.Promise && Object.assign && Array.prototype.includes
              && String.prototype.includes && document.querySelectorAll && window.addEventListener);
    return { https: location.protocol === "https:", file: location.protocol === "file:", storage: storage, bc: bc, audio: audio, hls: hls, legacy: legacy };
  })();

  /* --- can THIS browser play THIS station? 1 yes · 2 HLS-only · 3 playlist file · 4 unencrypted http --- */
  var KIND_TEXT = {
    2: { tag: "HLS", why: "it streams in HLS format, which only Safari and Android Chrome play natively" },
    3: { tag: "PLAYLIST", why: "its stream is a .pls/.m3u playlist file, which no web page can open (a desktop player such as VLC can)" },
    4: { tag: "HTTP", why: "it only offers an unencrypted (http) stream, which your browser blocks on a secure https page" }
  };
  function playKind(s) {
    var u = (s && s.u) || ""; if (!u) return 3;
    if (CAP.https && u.slice(0, 7) === "http://") return 4;
    var p = u.split("?")[0].toLowerCase();
    if (/\.m3u8$/.test(p)) return CAP.hls ? 1 : 2;
    if (/\.(pls|m3u|asx|wax|wpl|ram|mpd)$/.test(p)) return 3;
    return 1;
  }
  var playable = function (s) { return playKind(s) === 1; };

  /* ============================== hooks ============================== */
  var hooks = { onStation: null, onPlaying: null, onVol: null, onFavs: null, toast: null, toastAction: null, notice: null, onLive: null };
  function say(msg, ms) { if (hooks.toast) hooks.toast(msg, ms); }
  function warn(html, kind, opts) { if (hooks.notice) hooks.notice(html, kind, opts || {}); else say(String(html).replace(/<[^>]+>/g, ""), 8000); }

  /* ======================= cross-window channel ======================= */
  var CHAN = "rbg-v1";
  var channel = (function () {
    if (window.BroadcastChannel) {
      var c = new BroadcastChannel(CHAN);
      var subs = [];
      c.onmessage = function (e) { for (var i = 0; i < subs.length; i++) { try { subs[i](e.data); } catch (err) {} } };
      return { post: function (m) { try { c.postMessage(m); } catch (e) {} }, on: function (fn) { subs.push(fn); }, close: function () { try { c.close(); } catch (e) {} } };
    }
    var KEY = "rbg-relay";
    return {
      post: function (m) { try { localStorage.setItem(KEY, JSON.stringify({ m: m, t: Date.now(), r: Math.random() })); } catch (e) {} },
      on: function (fn) { var h = function (e) { if (e.key === KEY && e.newValue) { try { fn(JSON.parse(e.newValue).m); } catch (_) {} } }; window.addEventListener("storage", h); return function () { window.removeEventListener("storage", h); }; },
      close: function () {}
    };
  })();
  /* presence: the mini player watches a main page's heartbeat for its status badge. */
  setInterval(function () { ls.set("alive-main", Date.now()); }, 2500);

  /* ============================== player ==============================
     SINGLE-STREAM POLICY: exactly one window holds the <audio> element. Every other
     window (pop-out, dock, extra tabs — and the World View page) is a remote
     control that sends commands to the owner. Nothing is ever moved between
     windows, so opening/closing the pop-out or opening another page can never
     restart or double the stream. */
  var audio = new Audio();
  audio.preload = "none";
  var CID = Math.random().toString(36).slice(2, 10);   // this window's id
  var KIND = "main";                                   // 'main' | 'pop'
  var P = { cur: null, playing: false, vol: ls.get("vol", 0.9), mine: false, remoteKind: "" };
  audio.volume = P.vol;
  var M = function (s) { return { i: s.i, u: s.u, hp: s.hp || "", f: s.f || "", n: s.n, c: s.c, cc: s.cc, s: s.s || "", l: s.l || "", x: s.x || "", b: s.b || 0, v: s.v || 0, k: s.k || 0 }; };
  var ownRec = function () { return ls.get("owner", null); };
  var ownFresh = function (r) { return !!(r && (Date.now() - (r.ts || 0)) < 4000); };
  var ownMine = function () { var r = ownRec(); return !!(r && r.id === CID && ownFresh(r)); };
  var relOwner = function () { var r = ownRec(); return ownFresh(r) ? r : null; };
  function setOwner(playing) { ls.set("owner", { id: CID, kind: KIND, ts: Date.now(), playing: !!playing, uuid: (P.cur && P.cur.i) || null }); }
  function bcastState() { channel.post({ type: "state", from: CID, kind: KIND, playing: P.playing, mine: ownMine(), vol: P.vol, M: P.cur }); }
  audio.addEventListener("error", function () { if (P.mine && P.playing) { audioStop(); say("⚠ That stream won't play here — try another station."); } });
  function setPlaying(on) {
    P.playing = on; P.mine = ownMine();
    if (hooks.onPlaying) hooks.onPlaying(!!on, { mine: P.mine, remoteKind: P.remoteKind });
  }
  function setStation(m) {
    P.cur = m;
    if (hooks.onStation) hooks.onStation(m);
    if (m) ls.set("last", { m: m, ts: Date.now() });
  }
  /* --- the follower: live, silent, and ready ------------------------------------------------
     Exactly one window *sounds* the stream; a window that expects to get it back keeps its
     own element PRIMED (a short fetch, not a permanent second listener — measured in the
     page's own history: a live muted standby dies when the station allows one listener). */
  var primedFor = null;
  function primeElement(m) {
    var u = m && m.u; if (!u) return false;
    if (primedFor === u && audio.getAttribute("src")) return true;   // never re-load a live stream
    primedFor = u; audio.preload = "auto";
    try { audio.src = u; audio.load(); } catch (e) {}
    return true;
  }
  function dropPrime() { primedFor = null; audio.preload = "none"; try { audio.muted = false; audio.removeAttribute("src"); } catch (e) {} }
  function warmFollower() {
    if (P.mine) return;
    if (!P.playing || !P.cur) { if (!P.playing) dropPrime(); return; }
    primeElement(P.cur);
  }

  /* --- audio control: only an owner ever touches the element --- */
  var lastPlayErr = "", handover = false, resumeAt = 0, holdClaim = 0;
  function audioStart(m, quiet) {
    setStation(m); P.mine = true;
    primeElement(m); audio.volume = P.vol;
    audio.play().then(function () { lastPlayErr = ""; setOwner(true); setPlaying(true); bcastState(); })
      .catch(function (e) {
        lastPlayErr = (e && e.name) || "error"; setPlaying(false); setOwner(false); P.mine = false;
        /* a carry-over attempt stays quiet WHATEVER the failure: this page's own one-tap offer
           below is the message. (A quiet failure with any error other than NotAllowedError used
           to show a misleading "browser blocked" toast here AND skip the offer - the worst of
           both: a scary wrong message and no way back. It no longer does.) */
        if (!quiet) say(lastPlayErr === "NotAllowedError"
          ? "⚠ Your browser blocked playback — press ▶ to start."
          : "⚠ Playback didn't start — press ▶ to try again.");
        bcastState();
      });
  }
  function audioStop(silent) {
    handover = false; lastPlayErr = ""; try { audio.pause(); } catch (e) {} dropPrime();
    if (ownMine()) setOwner(false); P.mine = false; setPlaying(false); bcastState();
    if (!silent) say("Playback stopped.");
  }
  /* --- intents: available in every window --- */
  function claimAndPlay(m, fast, quiet) {
    if (ownMine()) { audioStart(m, quiet); addRecent(m); return; }
    setOwner(false);                                            // announce the takeover…
    /* the wait settles a race between windows that all want the stream; a window handing it
       over on purpose is not a race, so that path goes at once (fast). */
    setTimeout(function () {
      var r = relOwner();                                       // …then confirm we won it
      if (r && r.id !== CID) { setStation(m); addRecent(m); P.remoteKind = r.kind || ""; setPlaying(true); return; }
      audioStart(m, quiet); addRecent(m);
    }, fast ? 40 : 300 + Math.floor(Math.random() * 180));
  }
  function requestPlay(m, quiet) {
    if (hooks.willPlay) hooks.willPlay(m);
    var r = relOwner();
    if (r && r.id !== CID) {
      channel.post({ type: "cmd", from: CID, cmd: "play", M: m });
      setStation(m); addRecent(m); P.remoteKind = r.kind || ""; P.mine = false; setPlaying(true); return;
    }
    claimAndPlay(m, false, quiet);
  }
  function requestToggle() {
    if (P.playing && ownMine()) { audioStop(); return; }
    if (P.playing) { channel.post({ type: "cmd", from: CID, cmd: "stop" }); P.mine = false; setPlaying(false); return; }
    if (P.cur) requestPlay(P.cur); else say(hooks.pickPrompt || "Pick a station first — hit ▶ on any card.");
  }
  function requestStop() { if (ownMine()) audioStop(); else { channel.post({ type: "cmd", from: CID, cmd: "stop" }); P.mine = false; setPlaying(false); } }
  /* --- carry-over (S3c): the stream survives a page switch ------------------------------------
     When a page leaves it writes the owner record with left = the moment it went away (see the
     pagehide below). The next page to boot sees playing:true, a uuid and a recent left - proof
     the user had music going and only changed pages - and asks for the stream back. A browser
     that refuses sound without a fresh gesture makes play() reject; instead of the bare "press
     play" toast, resumePlay() then offers one tap that spends the gesture. */
  function resumePending() {
    var r = ownRec();
    if (!r || ownFresh(r)) return null;              /* no record, or a live owner (hello/state covers it) */
    if (!r.playing || !r.left) return null;          /* nothing was playing / a record from before this feature */
    if (Date.now() - r.left > 15000) return null;    /* too old to be a page switch */
    var lm = ls.get("last", null);
    if (!lm || !lm.m || !lm.m.u || (r.uuid && lm.m.i !== r.uuid)) return null;
    return lm.m;
  }
  function resumeOffer(m) {
    var go = function () { requestPlay(m); };
    if (hooks.toastAction) hooks.toastAction("⏸ The music stopped when you changed pages — " + ((m && m.n) || "the station") + " is ready.", "▶ Resume", go, 9000);
    else say("Press ▶ to resume " + ((m && m.n) || "the station") + ".", 9000);
  }
  function resumePlay(m) {
    requestPlay(m, true);                            /* the attempt is quiet; a failure gets the offer */
    /* Offer on any FAILED attempt (a settled error of any name), not just NotAllowedError: a play
       that is merely still connecting is not a failure. Whatever stopped the music from coming
       back, the one tap is the way home (and a tap turns a refusal into a real play). Two checks:
       the second catches a failure that only settles after the first (a slow dead mount). */
    setTimeout(function () { if (!P.playing && lastPlayErr) resumeOffer(m); }, 1600);
    setTimeout(function () { if (!P.playing && lastPlayErr) resumeOffer(m); }, 5200);
  }
  function setVol(v) {
    P.vol = +v; audio.volume = P.vol; ls.set("vol", P.vol);
    if (hooks.onVol) hooks.onVol(P.vol);
    if (ownMine()) bcastState(); else channel.post({ type: "cmd", from: CID, cmd: "vol", v: P.vol });
  }
  /* stop touching the audio without stopping the music: another window is taking over */
  function releaseToOther(kind) {
    if (ownMine()) ls.set("owner", { id: CID, kind: KIND, ts: Date.now() - 60000, playing: P.playing, uuid: (P.cur && P.cur.i) || null });
    P.mine = false; P.remoteKind = kind || "pop"; setPlaying(P.playing); bcastState();
    try { audio.pause(); } catch (e) {} warmFollower();          /* keep the buffer: we expect it back */
  }
  /* hand playback over when a window is about to disappear (page closed / reloaded) */
  window.addEventListener("pagehide", function () {
    ls.set("alive-main", 0);
    if (ownMine()) {
      ls.set("owner", { id: CID, kind: KIND, ts: Date.now() - 60000, playing: P.playing, uuid: (P.cur && P.cur.i) || null, left: Date.now() });  // sync write survives unload
      channel.post({ type: "handoff", M: P.cur });
    }
  });

  /* ======================= channel protocol ======================= */
  channel.on(function (m) {
    if (!m || m.from === CID) return;
    switch (m.type) {
      case "hello": if (ownMine()) bcastState(); break;
      case "state": if (!ownMine()) {                     // mirror the owner; never touch our own audio
        if (typeof m.vol === "number" && m.vol !== P.vol) { P.vol = m.vol; audio.volume = P.vol; if (hooks.onVol) hooks.onVol(P.vol); }
        if (m.M) setStation(m.M);
        P.remoteKind = m.kind || "";
        setPlaying(!!m.playing); warmFollower();          /* ready to take it back in a moment */ }
        break;
      case "cmd":                                          // only the audio owner executes commands
        if (ownMine()) {
          if (m.cmd === "play") { audioStart(m.M); addRecent(m.M); }
          else if (m.cmd === "stop") { audioStop(true); }
          else if (m.cmd === "vol") { P.vol = +m.v; audio.volume = P.vol; ls.set("vol", P.vol); if (hooks.onVol) hooks.onVol(P.vol); bcastState(); }
        } else if (m.cmd === "stop") { P.mine = false; setPlaying(false); }
        break;
      case "handoff":                                      // a window is leaving: whoever is left continues the stream
        if (m.to && m.to !== KIND) break;                  // addressed to another kind of window
        if (!ownMine() && m.M) {
          var hm = m.M, from = m.from;
          setTimeout(function () { var r2 = relOwner(); if (!r2 || r2.id === CID || r2.id === from) claimAndPlay(hm, true); }, 40);
        }
        break;
      case "handover":                                     // the mini player is adopting the stream: stand by, stay live
        if (ownMine() || audio.src) {
          handover = true; holdClaim = Date.now() + 3000;
          ls.set("owner", { id: CID, kind: KIND, ts: Date.now() - 60000, playing: true, uuid: (P.cur && P.cur.i) || null });
          P.mine = false; P.remoteKind = "pop"; setPlaying(true); bcastState();
          try { audio.pause(); } catch (e) {} warmFollower(); }  /* its connection is the one that matters now */
        break;
      case "tookover":                                     // it is really playing there: go quiet, stay live
        if (handover) {
          handover = false; try { audio.pause(); } catch (e) {}
          P.mine = false; P.remoteKind = "pop"; setPlaying(true); bcastState(); warmFollower(); }
        break;
      case "takeoverfailed":                               // it could not autoplay: the music must not be lost
        if (!ownMine() && (m.M || P.cur)) {
          handover = false; holdClaim = 0;
          var want = m.M || P.cur;
          if (audio.src) {
            audio.play().then(function () { P.mine = true; setOwner(true); setPlaying(true); bcastState(); })
              .catch(function () { setPlaying(false); say("⚠ Press ▶ to keep playing here."); });
          } else { setOwner(false); setTimeout(function () { claimAndPlay(want); }, 80); }
          /* No notice here on purpose: the stream is still playing and that is the whole promise. */ }
        break;
      case "takingover":                                   // legacy note from an older pop-out: drop our audio
        holdClaim = Date.now() + 2500; releaseToOther("pop"); break;
      case "favupd":
        favSet = new Set(favList());
        if (hooks.onFavs) hooks.onFavs();
        break;
      case "search": {                                     // the mini player asks any data page to search
        var q = (m.q || "").toLowerCase(); if (!q) break; var out = [];
        /* allStations, not ALL: a search finds the stations the user added themselves too. */
        for (var i = 0; i < allStations.length && out.length < 24; i++) {
          var s = allStations[i];
          if ((s.n + " " + countryOf(s) + " " + (s.t || "") + " " + (s.l || "") + " " + (s.x || "")).toLowerCase().indexOf(q) !== -1) out.push(M(s));
        }
        channel.post({ type: "searchRes", id: m.id, res: out }); break;
      }
    }
  });
  /* keep the ownership stamp alive while we hold the audio. The stamp says "playing" only
     while this window's element really is playing — a window that has merely RESERVED the
     stream must not look like the one making the sound. */
  setInterval(function () { if (ownMine()) setOwner(P.playing && !audio.paused); }, 2000);
  /* if the owner window disappears, the next window keeps the music going
     (main tabs get first refusal, pop-outs wait ~2.6 s so audio prefers a real tab) */
  setInterval(function () {
    warmFollower(); var r = ownRec();
    if (Date.now() < holdClaim || handover) return;
    if (!ownMine() && P.playing && !ownFresh(r)) {
      if (!resumeAt) resumeAt = Date.now() + 400;
      if (Date.now() >= resumeAt) { resumeAt = 0; claimAndPlay(P.cur); }
    } else resumeAt = 0;
  }, 900);

  /* recents */
  var recents = function () { return ls.get("rec", []); };
  var metaMap = function () { return ls.get("meta", {}); };
  function addRecent(m) {
    var r = recents().filter(function (u) { return u !== m.i; }); r.unshift(m.i); ls.set("rec", r.slice(0, 24));
    var mm = metaMap(); mm[m.i] = m; ls.set("meta", mm); channel.post({ type: "recupd" });
  }
  /* favourites — "My stations" */
  var favSet = new Set(ls.get("fav", []));
  var favList = function () { return ls.get("fav", []); };
  function saveFav(s) {
    var l = favList().filter(function (x) { return x !== s.i; }); l.unshift(s.i); ls.set("fav", l.slice(0, 300));
    var mm = metaMap(); mm[s.i] = M(s); ls.set("meta", mm); favSet = new Set(ls.get("fav", []));
    channel.post({ type: "favupd" }); say("★ Saved to My stations");
    if (hooks.onFavs) hooks.onFavs();
  }
  function rmFav(i) {
    ls.set("fav", favList().filter(function (x) { return x !== i; })); favSet = new Set(ls.get("fav", []));
    channel.post({ type: "favupd" }); if (hooks.onFavs) hooks.onFavs();
  }
  function toggleFav(s) { if (favSet.has(s.i)) { rmFav(s.i); say("Removed from My stations"); } else saveFav(s); }

  /* ==================== the user's own stations ====================
     They live in THIS browser and nowhere else (localStorage "rbg-custom") — the
     site still sends nothing to anybody. They are merged into the list exactly
     like catalogue entries; the list, the counts and the globe read allStations. */
  var CUSTOM_KEY = "custom";
  function customStations() {
    var v = ls.get(CUSTOM_KEY, []);
    return Array.isArray(v) ? v.filter(function (s) { return s && s.n && s.u; }) : [];
  }
  var customSig = "";
  var allStations = ALL;
  function refreshCustom() {
    var custom = customStations();
    var sig = custom.map(function (s) { return s.i; }).join("|");
    if (sig !== customSig) {
      customSig = sig;
      allStations = custom.length ? custom.concat(ALL) : ALL;
      _unplayable = -1;        // the count the Verified switch quotes has to be taken again
    }
    return custom;
  }
  var isCustom = function (s) { return !!(s && s.i && s.i.indexOf("custom-") === 0); };
  var _unplayable = -1;
  function unplayableCount() {
    if (_unplayable < 0) { var n = 0; for (var i = 0; i < allStations.length; i++) if (!playable(allStations[i])) n++; _unplayable = n; }
    return _unplayable;
  }

  /* unplayable, with the same two-route message the list uses: a toast now, a
     persistent notice with a "try anyway" that plays it regardless. */
  function unplayableNotice(s, k) {
    var t = KIND_TEXT[k] || KIND_TEXT[3];
    say("⚠ " + s.n + " can't play in this browser — " + t.why + ".", 7000);
    warn("⚠ <b>" + esc(s.n) + "</b> can't play here: " + t.why + "." +
      (s.hp ? " <a href=\"" + esc(s.hp) + "\" target=\"_blank\" rel=\"noopener noreferrer\">Open the station's website ↗</a>" : "") +
      "<button type=\"button\" class=\"nbtn\" id=\"noticeTry\">try anyway</button>",
      "warn", { tryAgain: function () { requestPlay(M(s)); } });
  }

  /* ======================= the liveness layer =======================
     live.json (written by check-liveness.py, uploaded on its own) is a LAYER like curated.json:
     the mirror still owns the catalogue; this file only says who was reachable at the last
     sweep. Quiet stations (2+ consecutive failed sweeps) are dimmed out of the list and the
     globe by the Hide-quiet switch — never deleted. No live.json -> everything reads "live". */
  var live = { ok: false, meta: null, quiet: new Set(), warn: new Set(), unchecked: new Set() };
  function loadLive() {
    try {
      fetch("live.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || j.v !== 1) return;
          live.ok = true; live.meta = j;
          live.quiet = new Set(); live.warn = new Set();
          live.unchecked = new Set(j.unchecked || []);
          var f = j.fails || {};
          for (var k in f) {
            var e = f[k];
            if (e && e[1] >= 2) live.quiet.add(k); else live.warn.add(k);
          }
          if (hooks.onLive) { try { hooks.onLive(j); } catch (e2) {} }
        }).catch(function () {});
    } catch (e) {}
  }
  function liveStatus(uuid) {
    if (!uuid || uuid.indexOf("custom-") === 0) return "none";
    if (live.quiet.has(uuid)) return "quiet";
    if (live.warn.has(uuid)) return "warn";
    if (live.unchecked.has(uuid)) return "unknown";
    return live.ok ? "ok" : "none";
  }
  var LIVE_TEXT = {
    ok: "Live — passed the last check",
    warn: "Missed the last check — retrying next sweep",
    quiet: "Quiet — failed two or more checks in a row",
    unknown: "Not checked yet",
    none: ""
  };
  /* the one-shot client probe the details panels' "check now" uses — the same truth rules as the
     add-a-station test: a CORS-readable answer names status + type; a blocked read still proves
     the host answered; silence is "no answer", never a guess. */
  function probeStream(url, cb) {
    var t0 = Date.now(), settled = false;
    function fin(state, detail) { if (!settled) { settled = true; cb(state, detail || {}, Date.now() - t0); } }
    try {
      fetch(url, { mode: "cors", cache: "no-store" })
        .then(function (r) { var ct = r.headers.get("content-type") || "";
          if (r.body && r.body.cancel) { try { r.body.cancel(); } catch (e) {} }
          fin("responds", { code: r.status, ctype: ct }); })
        .catch(function () {
          fetch(url, { mode: "no-cors", cache: "no-store" })
            .then(function () { fin("answered", {}); })
            .catch(function () { fin("noanswer", {}); });
        });
    } catch (e) { fin("noanswer", {}); }
    setTimeout(function () { fin("timeout", {}); }, 8000);
  }

  /* ======================= filters / state ======================= */
  var state = { q: "", cc: "", lang: "", codec: "", bit: 0, sort: "k", tags: [], page: 1, favOnly: false, playOnly: ls.get("playonly", true), hideQuiet: ls.get("hidequiet", true) };
  loadLive();                                    /* the liveness layer, whenever the site has one */
  function matchAll(s, excl) {
    if (state.favOnly && !favSet.has(s.i)) return false;
    if (state.playOnly && !playable(s)) return false;      // default: only stations this browser can really play
    if (state.hideQuiet && live.quiet.has(s.i)) return false;   // liveness: quiet stations stay out of sight (never deleted)
    if (state.cc && s.cc !== state.cc) return false;
    if (state.lang && normLang(s.l) !== state.lang) return false;
    if (state.codec && s.x !== state.codec) return false;
    if (state.bit && (s.b || 0) < state.bit) return false;
    if (!excl.tags && state.tags.length) { var t = new Set(tokens(s.t)); for (var i = 0; i < state.tags.length; i++) if (!t.has(state.tags[i])) return false; }
    if (!excl.q && state.q) {
      var hay = (s.n + " " + countryOf(s) + " " + (s.s || "") + " " + (s.l || "") + " " + (s.t || "") + " " + (s.x || "")).toLowerCase();
      if (hay.indexOf(state.q) === -1) return false;
    }
    return true;
  }

  return {
    VERSION: "1.0",
    hooks: hooks,
    ls: ls,
    CAP: CAP,
    REDUCED: REDUCED,
    esc: esc, fmt: fmt, flag: flag, tokens: tokens, normLang: normLang, ccName: ccName, countryOf: countryOf,
    copyText: copyText,
    data: {
      META: META, ALL: ALL,
      all: function () { return allStations; },
      custom: customStations, refreshCustom: refreshCustom, isCustom: isCustom,
      unplayableCount: unplayableCount
    },
    filters: { state: state, matchAll: matchAll, playable: playable },
    play: {
      KIND_TEXT: KIND_TEXT, playKind: playKind, M: M,
      requestPlay: requestPlay, requestToggle: requestToggle, requestStop: requestStop,
      setVol: setVol, setStation: setStation, setPlaying: setPlaying,
      cur: function () { return P.cur; }, playing: function () { return P.playing; },
      vol: function () { return P.vol; }, mine: function () { return ownMine(); },
      owner: relOwner, ownerMine: ownMine, cid: function () { return CID; },
      resumePending: resumePending, resumePlay: resumePlay,
      audioEl: function () { return audio; }, primed: function () { return primedFor; },
      lastErr: function () { return lastPlayErr; },
      handover: function () { return handover; },
      unplayableNotice: unplayableNotice
    },
    fav: {
      list: favList, has: function (i) { return favSet.has(i); }, size: function () { return favSet.size; },
      toggle: toggleFav, save: saveFav, rm: rmFav
    },
    recents: { list: recents, meta: metaMap },
    live: { load: loadLive, status: liveStatus, TEXT: LIVE_TEXT, raw: function () { return live; } },
    probe: { stream: probeStream },
    chan: channel
  };

})();
