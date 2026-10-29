/* MODDYS World Radio - the app install helper.
 *
 * One file, used twice: by the small "Get the app" block in the site header, and by the
 * full downloads page. Both need the same three things, and none of them should ever
 * disagree with the other:
 *
 *   1. WHERE the files are (CONFIG below - the only place to edit)
 *   2. WHAT this visitor's device is, and whether the app will work on it
 *   3. The wording of that verdict
 *
 * The numbers here are the SAME numbers both apps carry in their compat.json (Android 8.0
 * installs / 11 tuned, iOS 15 installs / 18 tuned). If they change in the apps, change them
 * here - the two apps and this page are the three places a visitor can be told, and all three
 * have to say the same thing.
 *
 * Nothing is loaded from anywhere: no fonts, no analytics, no CDN. Just this file.
 */
window.WrInstall = (function () {
  "use strict";

  var CONFIG = {
    android: {
      hard: 8.0, hardLabel: "Android 8.0",
      soft: 11.0, softLabel: "Android 11",
      version: "1.9.0",
      /* Upload the APK to /downloads/ and this is the one people get. */
      file: "downloads/world-radio-v1.9.0.apk",
      /* Always-available fallback: the same file, from the GitHub release. */
      mirror: "https://github.com/ModdySwag/world-radio-android/releases/latest"
    },
    ios: {
      hard: 15.0, hardLabel: "iOS 15",
      soft: 18.0, softLabel: "iOS 18",
      version: "1.3.0",
      /* The .ipa is UNSIGNED - that is expected: iOS will not install it until a signing
         tool (Sideloadly, Feather, ESign...) signs it with an Apple ID. */
      file: "downloads/MODDYSWorldRadio-v1.3.0-unsigned.ipa",
      mirror: "https://github.com/ModdySwag/world-radio-ios/releases/latest",
      /* Set this the day it is on the App Store and the page changes by itself. */
      store: ""
    },
    sideloadly: "https://sideloadly.io/"
  };

  /* ------------------------------------------------------------------ where is this? ---- */

  function detect() {
    var ua = navigator.userAgent;

    var m = /Android\s+([0-9.]+)/.exec(ua);
    if (m) return { os: "android", version: parseFloat(m[1]), label: "Android " + m[1] };

    m = /(?:iPhone|iPad|iPod).*?OS\s+([0-9]+)[_.]([0-9]+)/.exec(ua);
    if (m) {
      return { os: "ios", version: parseFloat(m[1] + "." + m[2]),
               label: "iOS " + m[1] + "." + m[2] };
    }
    /* iPad Safari in desktop mode reports a Macintosh user agent and no version at all, so
       the honest answer is that the version cannot be read here - not a guess. */
    if (/Macintosh/.test(ua) && "ontouchend" in document) {
      return { os: "ios", version: null, label: "iPad" };
    }
    return { os: "other", version: null, label: "" };
  }

  /* --------------------------------------------------------------------- the verdict ---- */

  function verdict(device) {
    var a = CONFIG.android, i = CONFIG.ios;

    if (device.os === "android") {
      if (device.version === null) {
        return { kind: "note", html: "<b>Android detected.</b> The app needs <b>" + a.hardLabel +
          "</b> or newer to install. If the installer refuses it, this device is older than " +
          "that \u2014 the website works here in the meantime." };
      }
      if (device.version < a.hard) {
        return { kind: "bad", html: "<b>" + device.label + " detected.</b> The app needs <b>" +
          a.hardLabel + "</b> or newer, so it will not install on this device. The website " +
          "works fine here in your browser." };
      }
      if (device.version < a.soft) {
        return { kind: "warn", html: "<b>" + device.label + " detected.</b> The app does install " +
          "(" + a.hardLabel + " or newer) but it is tuned for <b>" + a.softLabel + "</b>. On a " +
          "device this old the WebView that actually plays the streams is usually years behind, " +
          "so expect some stations not to decode \u2014 the app itself will tell you exactly " +
          "which ones can play. Install it anyway; it costs nothing to try." };
      }
      return { kind: "ok", html: "<b>" + device.label + " detected \u2014 compatible.</b> " +
        "Nothing to worry about: this is on or past the " + a.softLabel + " the app is tuned for." };
    }

    if (device.os === "ios") {
      if (device.version === null) {
        return { kind: "note", html: "<b>iPad detected.</b> The app needs <b>" + i.hardLabel +
          "</b> or newer. Safari in desktop mode does not report the version \u2014 check " +
          "Settings \u2192 General \u2192 About. Either way, <b>Add to Home Screen</b> below " +
          "works right now, on every version." };
      }
      if (device.version < i.hard) {
        return { kind: "bad", html: "<b>" + device.label + " detected.</b> The app needs <b>" +
          i.hardLabel + "</b> or newer and cannot be installed on this device. " +
          "<b>Add to Home Screen</b> below still gives you the full radio, full screen." };
      }
      if (device.version < i.soft) {
        return { kind: "warn", html: "<b>" + device.label + " detected.</b> The app installs " +
          "(" + i.hardLabel + " or newer) but it is tuned for <b>" + i.softLabel +
          "</b> or newer: on an older iOS the WebKit engine that plays the streams cannot be " +
          "updated on its own, so some stations may not start. The app's Check panel says which, " +
          "for your exact device. It is still worth installing." };
      }
      return { kind: "ok", html: "<b>" + device.label + " detected \u2014 compatible.</b> " +
        "You are on or past the " + i.softLabel + " the app is tuned for." };
    }

    return { kind: "note", html: "Two apps, one station list: <b>Android</b> (" +
      a.hardLabel + " or newer) and <b>iPhone / iPad</b> (" + i.hardLabel +
      " or newer). Open this page on the phone itself and it will check your version." };
  }

  /* ------------------------------------------------------------------------ the glue ---- */

  /* Fill a verdict box the same way everywhere. */
  function mount(box) {
    if (!box) return verdict(detect());
    var v = verdict(detect());
    box.className = (box.className.replace(/\s*wr-verdict-\S+/g, "") + " wr-verdict-" + v.kind).trim();
    box.innerHTML = v.html;
    return v;
  }

  /* Point a download link at CONFIG, and mention the mirror when there is one. */
  function link(element, kind) {
    var spec = kind === "ios" ? CONFIG.ios : CONFIG.android;
    if (!element) return;
    element.href = spec.file || spec.mirror || "#";
    element.setAttribute("data-target", kind);
  }

  /* Is the file actually there yet?
   *
   * The files live in /downloads/ and are uploaded by hand, so "not uploaded yet" is a state
   * this page has to survive rather than a mistake: a button that 404s is worse than a button
   * that says where it went instead. Opened from disk (file://) the probe cannot work, so it
   * is skipped rather than reporting a false negative. */
  function wireDownload(primary, note, kind) {
    var spec = kind === "ios" ? CONFIG.ios : CONFIG.android;
    if (!primary) return;

    primary.href = spec.file || spec.mirror || "#";
    primary.setAttribute("data-target", kind);

    function useLocal() {
      primary.href = spec.file;
      if (note) note.hidden = true;
    }

    function useMirror() {
      primary.href = spec.mirror;
      primary.textContent = kind === "ios" ? "⬇ Download the .ipa" : "⬇ Download the APK";
      if (note) {
        note.hidden = false;
        note.innerHTML = "This site's copy isn't uploaded yet, so that button goes to the " +
          "GitHub release instead.";
      }
    }

    if (!spec.file || !spec.mirror || location.protocol === "file:") { useLocal(); return; }

    var request = new XMLHttpRequest();
    request.open("HEAD", spec.file, true);
    request.onload = function () {
      if (request.status >= 200 && request.status < 400) { useLocal(); } else { useMirror(); }
    };
    request.onerror = useMirror;
    try { request.send(); } catch (e) { useLocal(); }
  }

  return {
    CONFIG: CONFIG,
    detect: detect,
    verdict: verdict,
    mount: mount,
    link: link,
    wireDownload: wireDownload,
    device: detect()
  };
})();
