# MODDYS World Radio for iOS v1.2.0

The whole World View now rides in the app: the door opens the full-page globe, served from the bundle, online or off.

## What changed

**The full World View page ships in the app.** The WORLD VIEW door above the toolbar was hidden inside the app while the app could not carry the page it opens - it can now, so the door shows and opens `world.html`, the whole standalone globe, from the bundle. Everything the site's page does, in the app: the MapLibre imagery globe with the day/night terminator and the density, saved and recent layers; search and the Format / Bitrate / Country filters pruning the dots and an open drawer live, with ◎ fly-to-results and 🎲 a random flight that tunes the station in; the place drawer, whose ▶ plays through the same single-owner player (lock-screen controls and notification included), and the "📍 N unmapped" chip browsing every station the catalogue cannot place - playable right there; the channels rail; deep links (`#q=` / `#cc=` / `#st=`) and the ⧉ share link; the LIST back-link home; and the ambient visualiser - all ten space styles plus the garden.

**A bundled page opens in place instead of being refused.** The shell was written when the app was one page: every relative link was handed to the native side, and the native side refuses `file://` addresses - so a second bundled page was unreachable. Pages that ship in the bundle (`world.html`, `index.html`) now navigate in the WebView; everything else keeps the old one-page behaviour.

**The page keeps its loopback origin.** The iOS shell already serves the bundled page from `127.0.0.1`, so the globe's labels fetch their bundled glyph set exactly as they do on the site - no file:// exceptions needed.

**The last pass's smaller fixes ride along:** bigger, softly glowing dots with a tap area that reaches past the dot; hold-to-zoom that keeps climbing on a busy page; the phone's retractable top bar; the one-tap ⓘ credits.

**The bundled web app is the current one**, byte for byte - the same `index.html`, `world.html`, `world.js`, `globeviz.js`, world data and `maplibre/` engine moddys.net serves, and the same file Android 1.8.0 carries.

## Verified

- `tools/shim_harness.py --only ios` over the iOS bridge, against the bundled page: 35 checks, 0 failed - the same harness file Android runs
- `scripts/verify_bundle.py` reads the published `.app`: every bundled web file - the world page, its `world.js` / `globeviz.js`, the vendored `maplibre/` engine and the glyph set included - is byte-identical to the repo copy
- the shared shell is pinned to the same revision Android ships (`SHIM.sha256`)
- the site's globe suites: the in-page globe 78 checks, the standalone World View page 194 checks, 0 failed

## Install

Sideload the unsigned `.ipa` with Sideloadly (or an on-device signer) and your own Apple ID - see the download page for the two steps. Your stations and favourites stay.

## Cheers Moddy !
