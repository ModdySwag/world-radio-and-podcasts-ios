#!/usr/bin/env python3
"""Check a built MODDYS World Radio .app: identity, install-time floor, shipped assets.

A green build is a claim, not evidence. This reads the artifact that would actually be
installed and asserts the things a user would notice if they were wrong:

  * the bundle id, display name and version
  * MinimumOSVersion - the install-time floor. This is what makes the App Store refuse the
    app on an old device, so it is the one number that must never drift from compat.json.
  * UIBackgroundModes contains audio (no background playback without it)
  * ATS permits cleartext (the ~8,330 http:// stations) without touching certificates
  * iPhone and iPad are both supported
  * the bundled web app is present and BYTE-IDENTICAL to the repo copy - index.html,
    stations.js and countries.js are the real site files, and the shell shim is the same
    file the Android app ships
  * the compiled binary actually contains the bridge and the notice (string literals only
    exist in the binary if the code that uses them was compiled in)

Usage:
    python3 scripts/verify_bundle.py path/to/MODDYSWorldRadio.app [--json out.json]
"""
import argparse
import hashlib
import json
import os
import plistlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
WWW = os.path.join(PROJECT, "Resources", "www")

SITE_FILES = ["index.html", "stations.js", "countries.js", "viz.js", "geo.js", "worldgeo.js", "globe.js",
              "wr-core.js", "world.html", "world.js", "globeviz.js",
              # 2.0.0: the podcast directory, its shelf manifest and its local corpus.
              "podcasts.html", "pod-index.js", "pod-search.js"]

# The directory's shelves, one file per shelf: 81 of them, so the check samples the first and
# last (a whole-folder recursion would be 81 x 2 checks that all say the same thing) plus the
# count, which is what would actually go wrong if the copy were interrupted.
PODI_SAMPLE = ["pod-i/cat-animation.js", "pod-i/lang-zh.js"]
PODI_EXPECT = 81

# The World View's vendored engine and glyphs: a folder on the site, shipped as www/maplibre/.
MAPLIBRE_FILES = ["maplibre/maplibre-gl.js", "maplibre/maplibre-gl.css",
                  "maplibre/fonts/NotoSansRegular/0-255.pbf", "maplibre/LICENSE.txt"]
SHARED_FILES = ["_shell_shim.js", "compat.json"]

# Strings that only exist in the binary if the code around them was compiled in.
BINARY_MARKERS = [b"__wrDevice", b"compat.notice.shown", b"_shell_shim.js",
                  b"LocalServer.port"]

failures = []
checks = 0


def check(label, condition, detail=""):
    global checks
    checks += 1
    if condition:
        print("  ok   " + label)
    else:
        print("  FAIL " + label + ((" :: " + str(detail)) if detail else ""))
        failures.append(label)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_resource(app, name):
    """The web app may be a folder reference (www/) or flat at the bundle root."""
    for candidate in (os.path.join(app, "www", name), os.path.join(app, name)):
        if os.path.isfile(candidate):
            return candidate
    return None


def check_plist(info, built=True):
    """The Info.plist contract, whether it is read out of a built .app or out of the repo.

    A built plist carries resolved values. The repo's copy defers three of them to build
    settings ($(PRODUCT_BUNDLE_IDENTIFIER), $(IPHONEOS_DEPLOYMENT_TARGET),
    $(TARGETED_DEVICE_FAMILY)), so in the repo the deferral is what can be checked - and
    verify_repo() then checks that project.yml resolves it to the value asserted here.
    """
    ident = info.get("CFBundleIdentifier")
    check("bundle id is the release id",
          ident == "com.moddys.worldradio" or (not built and ident == "$(PRODUCT_BUNDLE_IDENTIFIER)"),
          ident)
    check("display name",
          info.get("CFBundleDisplayName") == "Radio & Podcasts",
          info.get("CFBundleDisplayName"))

    # The install-time floor. Read compat.json rather than hard-code the number twice.
    with open(os.path.join(WWW, "compat.json"), encoding="utf-8") as handle:
        spec = json.load(handle)
    wanted = str(spec["os"]["hard"]["os"])
    found = str(info.get("MinimumOSVersion", ""))
    check("MinimumOSVersion matches compat.json's hard floor (%s)" % wanted,
          found == wanted or (not built and found == "$(IPHONEOS_DEPLOYMENT_TARGET)"), found)
    family = info.get("UIDeviceFamily")
    # The repo's plist omits this key entirely: Xcode fills it from TARGETED_DEVICE_FAMILY
    # while it processes the plist, and verify_repo() checks that setting.
    check("UIDeviceFamily is iPhone + iPad",
          (sorted(family) == [1, 2]) if isinstance(family, list)
          else (not built and family is None), family)
    check("background audio is declared",
          "audio" in (info.get("UIBackgroundModes") or []), info.get("UIBackgroundModes"))

    ats = info.get("NSAppTransportSecurity") or {}
    check("cleartext streams are permitted (the http:// stations)",
          ats.get("NSAllowsArbitraryLoads") is True, ats)
    check("ATS still validates certificates (no NSExceptionDomains overrides)",
          not ats.get("NSExceptionDomains"), ats.get("NSExceptionDomains"))
    check("the bundled page's loopback origin is allowed",
          ats.get("NSAllowsLocalNetworking") is True, ats)


def verify_repo():
    """Check the payload that goes INTO the .app, from the repo.

    A Windows host cannot build an iOS app, so this is the half of the gate that is reachable
    without a Mac: the Info.plist values, and the web payload exactly as XcodeGen copies it.
    The page contract is checked here too - a bundle must carry no site strip and must link
    its palette relatively, or the app opens a page with no colours over file://.
    Pass a path to a built .app on a Mac for the other half (the installed copy and the
    compiled binary's markers).
    """
    print("app bundle: (repo payload) " + WWW)
    plist_path = os.path.join(PROJECT, "Resources", "Info.plist")
    check("Info.plist is present", os.path.isfile(plist_path), plist_path)
    if not os.path.isfile(plist_path):
        return 1
    with open(plist_path, "rb") as handle:
        info = plistlib.load(handle)
    check_plist(info, built=False)

    # The three deferred values, resolved where XcodeGen reads them.
    with open(os.path.join(PROJECT, "project.yml"), encoding="utf-8") as handle:
        yml = handle.read()
    with open(os.path.join(WWW, "compat.json"), encoding="utf-8") as handle:
        spec = json.load(handle)
    check("project.yml sets the release bundle id",
          "PRODUCT_BUNDLE_IDENTIFIER: com.moddys.worldradio" in yml)
    check("project.yml sets the deployment floor compat.json wants (%s)" % spec["os"]["hard"]["os"],
          'IPHONEOS_DEPLOYMENT_TARGET: "%s"' % spec["os"]["hard"]["os"] in yml)
    check("project.yml targets iPhone + iPad", 'TARGETED_DEVICE_FAMILY: "1,2"' in yml)

    print("\n  the web payload:")
    for name in SITE_FILES + SHARED_FILES:
        path = os.path.join(WWW, name)
        check("ships %s" % name, os.path.isfile(path) and os.path.getsize(path) > 0, path)
    check("ships theme-tokens.css (the page's palette)", os.path.isfile(os.path.join(WWW, "theme-tokens.css")))

    index = os.path.join(WWW, "index.html")
    radio = os.path.join(WWW, "radio.html")
    if os.path.isfile(index) and os.path.isfile(radio):
        check("index.html (what the shell opens) is radio.html, byte for byte",
              sha256(index) == sha256(radio),
              "%s vs %s" % (sha256(index)[:16], sha256(radio)[:16]))

    for name in ["index.html", "radio.html", "world.html", "podcasts.html"]:
        path = os.path.join(WWW, name)
        if not os.path.isfile(path):
            continue
        html = open(path, encoding="utf-8", errors="replace").read()
        check("%s carries no site strip" % name,
              'href="/site-chrome.css' not in html and 'src="/site-chrome.js' not in html)
        check("%s links the palette relatively" % name,
              'href="theme-tokens.css' in html)

    shim = os.path.join(WWW, "_shell_shim.js")
    if os.path.isfile(shim):
        note = open(os.path.join(PROJECT, "SHIM.sha256"), encoding="utf-8").read().split()[0]
        check("the shim in the repo is the recorded shared-shell revision",
              sha256(shim) == note, "%s vs %s" % (sha256(shim)[:16], note[:16]))

    with open(os.path.join(WWW, "compat.json"), encoding="utf-8") as handle:
        spec = json.load(handle)
    check("compat.json says ios", spec.get("platform") == "ios", spec.get("platform"))
    check("compat.json still blocks installs below the hard floor",
          spec.get("os", {}).get("hardBlocksInstall") is True)

    print("\n%d checks, %d failed" % (checks, len(failures)))
    for failure in failures:
        print("  FAILED: " + failure)
    return 1 if failures else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("app", nargs="?", help="path to the built .app bundle (omit with --repo)")
    ap.add_argument("--repo", action="store_true",
                    help="check the repo payload (Info.plist + Resources/www) instead of a built .app")
    ap.add_argument("--json", default=None, help="write the result as JSON here")
    args = ap.parse_args()

    if args.repo:
        return verify_repo()
    if not args.app:
        print("Pass the path to a built .app, or --repo to check the payload in this checkout.",
              file=sys.stderr)
        return 2

    app = args.app
    print("app bundle: " + app)
    check("the .app exists", os.path.isdir(app), app)
    if not os.path.isdir(app):
        return 1

    # ---------------------------------------------------------------- Info.plist
    plist_path = os.path.join(app, "Info.plist")
    check("Info.plist is present", os.path.isfile(plist_path))
    if not os.path.isfile(plist_path):
        return 1
    with open(plist_path, "rb") as handle:
        info = plistlib.load(handle)
    check_plist(info)

    # ---------------------------------------------------------------- the web app
    for name in SITE_FILES + SHARED_FILES:
        source = os.path.join(WWW, name)
        shipped = find_resource(app, name)
        check("ships %s" % name, shipped is not None)
        if shipped is None:
            continue
        check("%s is byte-identical to the repo copy" % name,
              sha256(source) == sha256(shipped),
              "%s vs %s" % (sha256(source)[:16], sha256(shipped)[:16]))

    for name in MAPLIBRE_FILES:
        source = os.path.join(WWW, name)
        shipped = find_resource(app, name)
        check("ships %s" % name, shipped is not None)
        if shipped is None:
            continue
        check("%s is byte-identical to the repo copy" % name,
              sha256(source) == sha256(shipped),
              "%s vs %s" % (sha256(source)[:16], sha256(shipped)[:16]))

    # The podcast directory's shelves: sampled (see PODI_SAMPLE) plus the count, which is what
    # a half-finished copy - or an XcodeGen folder reference that dropped a subfolder - breaks.
    for name in PODI_SAMPLE:
        source = os.path.join(WWW, name)
        shipped = find_resource(app, name)
        check("ships %s" % name, shipped is not None)
        if shipped is None:
            continue
        check("%s is byte-identical to the repo copy" % name,
              sha256(source) == sha256(shipped),
              "%s vs %s" % (sha256(source)[:16], sha256(shipped)[:16]))
    shipped_podi = os.path.join(app, "www", "pod-i")
    shelf_count = len(os.listdir(shipped_podi)) if os.path.isdir(shipped_podi) else 0
    check("all %d shelf files ride in the bundle" % PODI_EXPECT,
          shelf_count == PODI_EXPECT, shelf_count)

    shim = find_resource(app, "_shell_shim.js")
    if shim:
        note = open(os.path.join(PROJECT, "SHIM.sha256"), encoding="utf-8").read().split()[0]
        check("the shim in the bundle is the recorded shared-shell revision",
              sha256(shim) == note, "%s vs %s" % (sha256(shim)[:16], note[:16]))

    shipped_spec = find_resource(app, "compat.json")
    if shipped_spec:
        with open(shipped_spec, encoding="utf-8") as handle:
            shipped = json.load(handle)
        check("the shipped compat.json still says ios",
              shipped.get("platform") == "ios", shipped.get("platform"))
        check("the shipped compat.json still blocks installs below the hard floor",
              shipped.get("os", {}).get("hardBlocksInstall") is True)

    # ---------------------------------------------------------------- the binary
    binary = os.path.join(app, os.path.basename(app).replace(".app", ""))
    if not os.path.isfile(binary):
        candidates = [f for f in os.listdir(app)
                      if os.path.isfile(os.path.join(app, f)) and not f.endswith(".plist")]
        binary = os.path.join(app, candidates[0]) if candidates else None
    check("the app binary is present", binary is not None and os.path.isfile(binary or ""))
    if binary and os.path.isfile(binary):
        blob = open(binary, "rb").read()
        for marker in BINARY_MARKERS:
            check("compiled in: %s" % marker.decode(),
                  marker in blob, "not found in %s" % os.path.basename(binary))
        check("size is plausible for a WebView shell",
              len(blob) > 100_000, "%d bytes" % len(blob))

    print("\n%d checks, %d failed" % (checks, len(failures)))
    for failure in failures:
        print("  FAILED: " + failure)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump({"checks": checks, "failures": failures}, handle, indent=2)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
