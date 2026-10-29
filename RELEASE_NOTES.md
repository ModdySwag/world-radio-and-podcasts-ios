# MODDYS World Radio & Podcasts for iOS v2.0.0

The app stops being a pure radio. The podcast directory now lives inside it - 58,795 shows to
browse, 54,539 of them searchable by typing, ranked on the phone rather than by a server - so the
one door the header keeps is a door that opens something.

## What changed

**The podcast directory ships in the app.** `podcasts.html`, the shelf manifest, the search corpus
and the 81 shelf files ride in `Resources/www`. Browsing needs no network; only a show's feed, its
charts and its artwork go online.

**One door in the header.** Inside the app the site doors were hidden outright, because they led
to pages the app does not carry. Now exactly one survives - the podcast directory - and it opens.
The Radio link at the top of the directory brings you back.

**Under the icon the name is shorter.** "MODDYS World Radio & Podcasts" is 29 characters and iOS
ellipsises that under an icon. The icon says **Radio & Podcasts**; the store listing carries the
full name.

**The bundled web app is today's**, byte for byte - the newer globe, the World View labels and
the current 71,577-station catalogue, which the bundle had been two weeks behind on.

## Verified

- `scripts/verify_bundle.py` reads the published `.app` - the simulator build and the device
  archive: **64 checks, 0 failed** each, including that all 81 shelf files are in the bundle and
  that the page files are byte-identical to the repo copies
- `tools/shim_harness.py` over the iOS bridge: **80 checks, 0 failed** - the same harness file the
  Android app runs, including the two new checks that pin `podcasts.html` and `radio.html` as
  in-app pages
- the shared shell is pinned to the same revision Android ships (`SHIM.sha256`)
- the site's page suite against this page: **277 checks, 0 failed**
- the site's podcast suite: **80 checks, 0 failed**

## Install

Sideload the unsigned `.ipa` with Sideloadly (or an on-device signer) and your own Apple ID - see
the download page for the two steps. Your stations and favourites stay.

## Cheers Moddy !
