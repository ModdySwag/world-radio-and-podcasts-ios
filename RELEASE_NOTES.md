# MODDYS World Radio for iOS v1.3.0

The app becomes the pure radio it always was on a phone: the site links that led nowhere are gone from the header, the search module folds away when you are done searching, and the search field gets a go magnifier.

## What changed

**The header drops the five site links.** DOWNLOADS / SYNTHHUB / MUSIC HUB / PATTERN FORGE / RESONANCE open pages the app does not carry - in a pure radio app they were five dead links. They are hidden inside the app now; the website keeps them, where they lead somewhere.

**The search module folds.** A ▾ sits at the right end of the search field on a phone: tap it and the stations bar, the Format / Bitrate / Country selects and the Add / Saved / Reset row tuck away, so the results get the screen - about 150px of it back on a 390px phone. The field itself stays, it is the thing you reach for again. Committing a search folds it for you (the keyboard's enter/go key, the field's ✕, or the new magnifier - the same habit the World View page's bar has); the ▴ brings everything straight back, and the choice is remembered on the device. Desktops never fold.

**A go magnifier in the search bar.** The 🔍 inside the field commits the search exactly like the keyboard's search key - and inside the app it drops the on-screen keyboard the moment you tap it.

**The bundled web app is the current one**, byte for byte - the same `index.html` moddys.net serves, and the same file Android 1.9.0 carries.

## Verified

- `tools/shim_harness.py --only ios` over the iOS bridge, against the bundled page: 35 checks, 0 failed - the same harness file Android runs
- `scripts/verify_bundle.py` reads the published `.app`: every bundled web file is byte-identical to the repo copy
- the shared shell is pinned to the same revision Android ships (`SHIM.sha256`)
- the site's page suite against this page: 275 checks, 0 failed (twelve of them new: the five doors, the fold, the magnifier)
- the same suite against what moddys.net serves: 275 checks, 0 failed

## Install

Sideload the unsigned `.ipa` with Sideloadly (or an on-device signer) and your own Apple ID - see the download page for the two steps. Your stations and favourites stay.

## Cheers Moddy !
