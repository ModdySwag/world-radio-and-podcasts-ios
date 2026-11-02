# MODDYS World Radio & Podcasts for iOS v2.1.0

The radio page stopped drawing two bars. On the web its controls now move into the site's
bottom strip, which is the one player there; inside the app there is no strip at all, so the
shell's sheet is the player and the page hands it the same controls it always owned. The
bundled page is today's - and it finally carries its own palette.

## What changed

**One player, and the app keeps the one it had.** `radio.html` now hands `#bPlay`, `#bStop`,
the volume, the visualiser, Website and Random to the site strip at load (`adoptStrip`), and
stops drawing the second bar it used to stack underneath it. A bundle ships no site chrome, so
the sync script cuts the strip's `<link>` and `<script>` out of every bundled page: inside the
app nothing tries to draw the site's navigation under the player sheet, and the page keeps its
own bar, hidden, as the control plane the sheet drives. The page was written for exactly this -
no strip, no adoption, its bar as it was.

**The page keeps its colours in the app.** The site links `/theme-tokens.css`, an absolute path
that does not resolve inside the bundle - the page would have painted with no palette at all.
`theme-tokens.css` ships in `Resources/www` now and the link is relative, on every bundled page:
the radio, the World View and the podcast directory.

**The idle player says what it means.** The MINI pop-out is retired, so the bar reads
**Nothing playing** until a station is chosen. The sheet and the Now Playing card take their
wording from it, and the shell sends an empty station name to the lock screen rather than the
words. The meta line under the name now skips the fields a station does not have, instead of
printing a bare "· ·".

**Auto-hide is the strip's switch**, not the app's: it folds the *site's* bar into a tab, and
there is no strip in here. The shell takes it off the screen rather than leave a switch that
promises something it cannot do.

**A drift check that fails.** `tools/sync-assets.py --check` now applies those two steps to the
site's bytes and compares every file - 17 of them - exiting non-zero if the bundle is behind.
"Current" is a command now, not a memory.

**The bundled web app is today's** - the single-player page, the 71,577-station catalogue, the
newer globe and the podcast directory - with only those two app-only differences.

## Verified

- `python3 tools/sync-assets.py --check`: **17 files, all match the site's bytes**; every
  bundled page carries no site strip and links its palette relatively; `index.html` and
  `radio.html` are identical
- `python3 scripts/verify_bundle.py --repo` checks the payload this host can reach without
  Xcode - Info.plist and the build settings it defers to, every shipped file, the page contract
  and the shim revision: **41 checks, 0 failed**
- `python3 tools/shim_harness.py` drives the real shell in a real browser on the iOS bridge
  (and the Android one, same file) against the bundled page: **84 checks, 0 failed** - including
  two new ones pinning that the idle player reads "Nothing playing" and that nothing on screen
  still says MINI
- the same files pulled from `https://moddys.net` with `--from-url` are identical to the local
  sync, byte for byte - so the CI path and the local path agree
- screenshots at 412×915 over `file://`, sheet collapsed and expanded: painted in the real
  palette, "Nothing playing", the transport and the nine nav buttons where they belong

## Install

Sideload the unsigned `.ipa` with Sideloadly (or an on-device signer) and your own Apple ID - see
the download page for the two steps. Your stations and favourites stay.

## Cheers Moddy !
