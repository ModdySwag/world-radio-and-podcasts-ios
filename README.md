# MODDYS World Radio — iPhone & iPad

**SPRAY IT LOUD, in your pocket — on iOS this time.** The same MODDYS World Radio web app,
in a WKWebView shell that keeps playing when you leave the app or lock the screen, puts the
station on your lock screen with play/pause, and doesn't lose the ~8,300 stations that stream
over plain `http://`.

It is the iOS twin of [world-radio-android](https://github.com/ModdySwag/world-radio-android),
built to behave identically: both apps ship the **same** `index.html`, `stations.js` and
`countries.js` as moddys.net, and the **same shell script** (`_shell_shim.js`, byte-identical
— `SHIM.sha256` proves it). One player, two platforms.

## Screenshots

The door at the top of the list, and the full World View it opens — the same pages the site
serves, riding inside the app since 1.2.0:

<img src="shots/phone-list.jpg" width="300" alt="MODDYS World Radio on iPhone — the station list with the World View door">
<img src="shots/phone-world.jpg" width="300" alt="MODDYS World Radio on iPhone — the World View on a phone">
<img src="shots/desktop-world.jpg" width="720" alt="MODDYS World Radio — the World View at desktop width">
<img src="shots/desktop-world-drawer.jpg" width="720" alt="MODDYS World Radio — a dot opened: the station drawer and the player">

## What it does

- **Background playback.** An `AVAudioSession` in the `.playback` category plus the `audio`
  background mode: the stream survives leaving the app and locking the device.
- **Lock-screen controls.** A real Now Playing card — artwork, station name, country ·
  language · codec · bitrate — with play/pause/stop. Live radio has no seek, so next/previous
  and scrubbing are deliberately *not* offered rather than offered and broken.
- **One player, dragged open.** Same bottom sheet as the Android app: drag it up for the full
  view, drag it down to fold it back. Volume, transport, and one-tap jumps to Search,
  Light/Dark, Favourites, Random, Playable, Reset, Top, Visual and Check.
- **Five visualiser styles, where you can actually see them** — the site hides its visualiser
  below 900px wide, so the shell lifts its canvas into the expanded player.
- **Light mode**, remembered between launches.
- **The Check panel used to report the WebView.** The Check panel reports this device: iOS
  version, hardware model, the WebKit version that decides which streams decode, codec
  support, and how many of the 47,994 stations this device can actually play — plus a **Copy
  report** button.
- **Station links go to Safari**, not into the player, exactly as on Android.
- **Favourites persist.** The page is served from a loopback address rather than `file://`
  precisely so `localStorage` behaves — see *How it fits together* below.
- **It recovers.** If iOS kills the web content process to reclaim memory, the page is
  rebuilt instead of leaving you with a blank screen and a dead player.

## Version compatibility — it tells you, in three places

This is the same three-part answer the Android app gives:

| where | what it says |
|---|---|
| **Before install** | `MinimumOSVersion` is **iOS 15**. The App Store will not offer the app to an older device, and an older device will not run it. Enforced by Apple, not by us. |
| **At first launch** | If the device is **below iOS 18** — the version this app is tuned for — one dismissible notice explains what is likely to be rough, why (the engine that plays the streams is part of iOS and cannot be updated on its own), and offers a button straight to the Check panel. Once per app version. Never a nag, never a modal you cannot dismiss. |
| **Any time, in the app** | The Check panel always reports the verdict, this device's real iOS and WebKit versions, and how much of the catalogue it can play, with a copy button for a bug report. |

The thresholds live in **one file**, `Resources/www/compat.json` — the launch notice, the
Check panel and the website's download section all read it, so they cannot drift apart. The
same file exists on the Android side with Android's numbers.

The honest summary: **iOS is the better of the two platforms for this catalogue.** HLS
(`.m3u8`, roughly 3,000 stations) is native on iOS and only works on Android where the System
WebView can decode it, so the Playable count on an iPhone is higher than on most Androids.

## Quick start

The build runs in **GitHub Actions on a macOS runner** — Apple's toolchain, without a Mac in
the room.

1. Push this repo (or **Actions → Build iOS app → Run workflow**).
2. Download the artifacts: `world-radio-ios-unsigned-ipa` (the app), `MODDYSWorldRadio-xcode-project`
   (the generated Xcode project), `world-radio-ios-verification` (what was checked).
3. **Read "Getting it onto a device" below before you plan on installing it.**

To build locally on a Mac you need Xcode and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`):

```bash
xcodegen generate                    # writes MODDYSWorldRadio.xcodeproj from project.yml
open MODDYSWorldRadio.xcodeproj      # or:
xcodebuild -project MODDYSWorldRadio.xcodeproj -scheme MODDYSWorldRadio \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```

There is no `.pbxproj` to review: the project is generated from `project.yml`, which is a page
you can actually read. CI regenerates it and commits it back, so the checkout is openable in
Xcode without running anything first.

## Getting it onto a device — read this part

An **unsigned** `.ipa` cannot be installed on a normal iPhone or iPad. iOS requires every app
to carry a signature from Apple, tied to a developer identity. There is no way around that,
and it is not something the build can do for you:

| route | what it needs | what you get |
|---|---|---|
| **Sideload** | a Windows PC or Mac, [Sideloadly](https://sideloadly.io/) or AltStore, *any* Apple ID (free) | the app on your own device, **re-signed every 7 days** with a free Apple ID. Fine for testing on your own phone. |
| **TestFlight / App Store** | **Apple Developer Program, $99/year** | installable by anyone, no expiry, no PC. This is the route for a public "Download the App" button. |
| **Home screen web app** | nothing at all | Safari → Share → *Add to Home Screen*. moddys.net runs full-screen with its own icon, and iOS keeps the audio playing when it is backgrounded. **This works today**, for everyone, with no account and no build. |

When you have the paid account, CI is already wired for it: add the secrets
`APPLE_API_KEY` (base64 of the App Store Connect `.p8`), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER_ID` and `APPLE_TEAM_ID`, and the `signed` job builds and verifies a signed
`.ipa` with `xcodebuild -allowProvisioningUpdates`. That path has **not been exercised yet** —
it activates the first time those secrets exist.

Two more honest notes about the App Store route:

- **Review guideline 4.2** ("minimum functionality") is the usual reason a website-in-a-box
  gets rejected. The defence is everything above: background playback, lock-screen controls,
  the player sheet, the visualiser, the per-device system check.
- **Cleartext `http://`** is declared in `NSAppTransportSecurity`. That is permitted with a
  justification, and the justification is in the plist comment: 8,330 of the 47,994 stations
  are plain HTTP. Certificate validation is **not** weakened.

## How it fits together

| file | role |
|---|---|
| `Sources/RadioViewController.swift` | hosts the web app, injects the shell, routes external links to Safari, recovers from a memory kill |
| `Sources/LocalServer.swift` | serves the bundled page to the WebView from `127.0.0.1`, loopback only |
| `Sources/NowPlaying.swift` | the Now Playing card and the lock-screen transport buttons |
| `Sources/Compatibility.swift` | reads `compat.json`, decides the verdict, shows the one-time notice |
| `Sources/AppDelegate.swift` | one window, no storyboard, no scene manifest |
| `Resources/www/_shell_shim.js` | the shared front end: player sheet, theme, visualiser, Check panel, bridge adapter |
| `Resources/www/compat.json` | the version thresholds, in one place |
| `Resources/Info.plist` | `MinimumOSVersion`, background audio, ATS, orientation, both device families |
| `tools/shim_harness.py` | drives that shell in a real browser, on the iOS bridge path too |

### Why a local server instead of `file://`

Three reasons, each of which bites on iOS:

1. `localStorage` on a `file://` origin is not reliably persistent, and favourites live there.
2. A `file://` page is an opaque origin, which makes its own script and data loading fragile.
3. Serving the page over `http` keeps the page and the streams on the same scheme, so the
   cleartext stations are not blocked as mixed content.

The port is pinned and remembered, because `localStorage` is keyed by origin — a different
port each launch would silently lose your favourites. If no loopback port can be opened, the
app falls back to `file://` and says so in the log rather than refusing to start.

### The bridge, in ten lines

Android hands JavaScript a synchronous object (`window.WorldRadioJs`). iOS cannot: the only
JS-to-native path is an asynchronous message handler. So the shell script carries both:

- `window.webkit.messageHandlers.wr.postMessage({m, a})` — every message, both platforms
- `window.__wrDevice` — the device facts, injected before the page runs, because iOS has no
  way to answer a JS call synchronously

That is the *entire* platform difference. Everything else — the player, the theme, the
visualiser, the compatibility notice, the Check panel — is one file shipped to both apps.

## Verifying a build

`scripts/verify_bundle.py` reads the built `.app` and checks what a user would notice if it
were wrong: bundle identity, `MinimumOSVersion` against `compat.json`, `UIBackgroundModes`,
the ATS declaration, both device families, that `index.html`/`stations.js`/`countries.js` are
**byte-identical** to the repo copies, that the shim is the recorded shared revision, and that
the compiled binary actually contains the bridge and the notice strings. CI runs it on both
the simulator build and the device archive, and keeps the reports as artifacts.

The shell itself is verified separately: `tools/shim_harness.py` drives the real page with the
real shim in headless Chromium on three paths — the Android bridge, the iOS message-handler
bridge, and no bridge at all (where the Check panel must say "not reported by this shell"
rather than invent a verdict).

## Compatibility

| | |
|---|---|
| iOS | **15.0 or newer to install** (`MinimumOSVersion`, enforced by the installer); tuned for **iOS 18** and newer |
| Devices | iPhone **and** iPad, portrait and landscape, Split View and Slide Over |
| Playback engine | Apple's **WebKit**, which ships with iOS — updated by updating iOS, not by the app |
| Formats | MP3 and AAC everywhere; **HLS is native on iOS**, so the ~3,000 `.m3u8` stations play here |
| Cleartext | allowed app-wide in `NSAppTransportSecurity`: ~8,330 stations are plain `http://` |
| No usable WebKit / page missing | the app says so in words instead of showing a blank screen |

## What you give up

- **Nothing you had on the web.** The app is a shell around the real site, not a fork of it.
- **Mixing:** the app declares a normal playback session, so iOS pauses other audio when the
  radio starts, as it does for any music app. If you want both at once, that is a system
  choice, not something this app will fight for.
- **The icon is placeholder art** (the same broadcast tower the Android app uses, redrawn for
  the 1024 grid) — replace it when you have real artwork.

## Privacy & safety

Nothing is collected and nothing is transmitted anywhere except the radio streams you press
play on. There are no analytics, no ads, no third-party SDKs and **no external dependencies
at all** — only Apple's own WKWebView, AVFoundation and MediaPlayer frameworks, plus a
loopback HTTP server that is bound to `127.0.0.1` and reachable by nothing off the device.
Cleartext HTTP is permitted because your catalogue needs it; that permits no certificate
weakening, and the only network traffic is the station stream itself.

Cheers Moddy !
