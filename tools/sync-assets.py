#!/usr/bin/env python3
"""Copy the live web app into the iOS project's bundle resources.

The station catalogue is ~18 MB, so it is not kept in the repo's history by hand - run this
whenever build.py refreshes the data, then commit the result (or let the CI workflow pull it
from the live site instead, see .github/workflows/ios.yml).

Note what this does NOT copy: `_shell_shim.js` and `compat.json` are app files, not site
files. The shim comes from the Android repo (tools/sync-shim.py), so both apps keep shipping
the same one.

A bundle is not the site, so two things are deliberately NOT copied verbatim:

  * the site strip. On the web, site-chrome.js moves radio.html's player controls into the
    site's bottom strip (adoptStrip) and the page stops drawing its own bar. A bundle ships
    no strip - the shell builds its own player sheet out of #bar - so the strip's <link> and
    <script> are cut out of every bundled page. Left in, the app would boot the site's
    navigation strip inside the WebView on top of the player sheet that already exists.

  * the palette. The site links /theme-tokens.css, an absolute path that is a 404 under
    file:// - the page would lose every colour it paints with. theme-tokens.css ships beside
    the pages and the link is rewritten to a relative one.

Both steps live in bundle_html(), so they run on every sync and cannot be lost in a hand
edit. A page whose head no longer matches those two patterns stops the sync with an error
rather than shipping a bundle that quietly carries the strip again.

Usage:
    python3 tools/sync-assets.py                 # from the local site folder
    python3 tools/sync-assets.py --from-url      # from https://moddys.net
    python3 tools/sync-assets.py --site DIR      # from somewhere else
    python3 tools/sync-assets.py --check         # compare the bundle with the site, change nothing
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DEST = os.path.join(PROJECT, "Resources", "www")

# popout.html is deliberately not shipped: it opens a second browser window for the
# single-owner handover, and a phone has no second window.
FILES = ["index.html", "radio.html", "stations.js", "countries.js", "viz.js", "geo.js", "worldgeo.js", "globe.js",
         "wr-core.js", "world.html", "world.js", "globeviz.js",
         # 2.0.0: the podcast directory. podcasts.html is the page, pod-index.js is the shelf
         # manifest (7.5 KB), pod-search.js is the local corpus (2.7 MB, loaded on focus).
         # radio.html carries the one in-app door that leads here.
         "podcasts.html", "pod-index.js", "pod-search.js",
         # radio.html loads this for its download block, which hides itself in-app
         # (html.wr-app #wrDownload). Without it the bundle 404s on every load.
         "app-install.js",
         # The palette. The site links it at /theme-tokens.css (an absolute site path, so a
         # 404 under file://); it ships here and every bundled page links it relatively.
         "theme-tokens.css"]

# The site's radio page moved to radio.html on 2026-10-26 (the front door took /).
# The app still loads www/index.html, so the radio is written twice: index.html (what the
# shell opens) and radio.html (so world.html's "Open in the list" links resolve in-app).
SOURCE_OF = {"index.html": "radio.html", "radio.html": "radio.html"}

# The full-page World View's vendored engine - a folder, copied recursively. pod-i/ is the
# podcast directory's 81 shelf files (13 MB): one shelf is fetched when a shelf is opened, so
# it ships as a folder rather than one file.
DIRS = ["maplibre", "pod-i"]

DEFAULT_SITES = [
    r"C:\Users\Moddy\radio-browser\deploy",
    r"C:\Users\Moddy\radio-browser",
]
LIVE = "https://moddys.net/"

HTML_SUFFIXES = (".html", ".htm")

# The site's head carries these two tags on every page the bundle ships. Each must appear
# exactly once, so a redesign that moves them is a loud failure here instead of a bundle
# that boots the site's navigation strip inside the app.
STRIP_TAGS = [
    ("site-chrome.css <link>",
     re.compile(r'[ \t]*<link\b[^>]*href="/site-chrome\.css[^"]*"[^>]*>[ \t]*\r?\n?', re.I)),
    ("site-chrome.js <script>",
     re.compile(r'[ \t]*<script\b[^>]*src="/site-chrome\.js[^"]*"[^>]*>[ \t]*</script>[ \t]*\r?\n?', re.I)),
]
TOKENS_TAG = re.compile(r'href="/theme-tokens\.css')


def has_strip(html):
    """True if a page still asks for the site's bottom strip."""
    return 'href="/site-chrome.css' in html or 'src="/site-chrome.js' in html


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def bundle_html(raw, name):
    """The site's page as the app ships it: no site strip, a relative palette link."""
    text = raw.decode("utf-8")
    for what, rx in STRIP_TAGS:
        text, n = rx.subn("", text)
        if n != 1:
            raise SystemExit(
                "bundle_html(%s): expected exactly one %s, found %d.\n"
                "The site's head changed shape - update tools/sync-assets.py before syncing, "
                "or the bundle would carry the site strip into the app." % (name, what, n))
    text, n = TOKENS_TAG.subn('href="theme-tokens.css', text)
    if n != 1:
        raise SystemExit(
            "bundle_html(%s): expected one /theme-tokens.css link, found %d.\n"
            "Without it the page has no palette in the app." % (name, n))
    return text.encode("utf-8")


def source_bytes(site, name):
    """What this file must contain in the bundle, straight from the site."""
    with open(os.path.join(site, SOURCE_OF.get(name, name)), "rb") as f:
        data = f.read()
    return bundle_html(data, name) if name.endswith(HTML_SUFFIXES) else data


def find_site(explicit):
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    for cand in DEFAULT_SITES:
        if os.path.isdir(cand) and os.path.isfile(os.path.join(cand, "index.html")):
            return cand
    return None


def from_url(dest):
    os.makedirs(dest, exist_ok=True)
    for name in FILES:
        url = LIVE + SOURCE_OF.get(name, name)
        out = os.path.join(dest, name)
        print(f"  fetching {url}")
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        if name.endswith(HTML_SUFFIXES):
            data = bundle_html(data, name)
        with open(out, "wb") as f:
            f.write(data)
    return True


def report(site):
    """List the bundle with hashes; with a site in hand, say whether each file is current."""
    print("\nassets in the project:")
    total, drift = 0, []
    for name in FILES:
        p = os.path.join(DEST, name)
        if not os.path.isfile(p):
            print(f"  {name:16s} {'MISSING':>12s}")
            drift.append(name)
            continue
        size = os.path.getsize(p)
        total += size
        line = f"  {name:16s} {size:>10,} B  sha256:{sha256(p)}"
        if site:
            want = source_bytes(site, name)
            if want == open(p, "rb").read():
                line += "  ok"
            else:
                line += f"  CHANGED (site has {len(want):,} B sha256:{hashlib.sha256(want).hexdigest()[:16]})"
                drift.append(name)
        print(line)
    print(f"  {'total':16s} {total:>10,} B")

    print("\nSanity check: does index.html load its data files?")
    idx = os.path.join(DEST, "index.html")
    if os.path.isfile(idx):
        html = open(idx, encoding="utf-8", errors="replace").read()
        for name in ("countries.js", "stations.js", "geo.js", "worldgeo.js", "globe.js", "wr-core.js"):
            print(f"  references {name}: {'yes' if name in html else 'NO'}")

    print("\nApp contract (the bundle is not the site):")
    for name in [f for f in FILES if f.endswith(HTML_SUFFIXES)]:
        p = os.path.join(DEST, name)
        if not os.path.isfile(p):
            continue
        html = open(p, encoding="utf-8", errors="replace").read()
        strip = "PRESENT - wrong" if has_strip(html) else "no"
        palette = "relative" if 'href="theme-tokens.css' in html else "MISSING"
        print(f"  {name:16s} site strip: {strip:14s} palette: {palette}")
    radio = os.path.join(DEST, "radio.html")
    if os.path.isfile(idx) and os.path.isfile(radio):
        same = open(idx, "rb").read() == open(radio, "rb").read()
        print(f"  index.html == radio.html: {'yes' if same else 'NO'}")

    if site:
        if drift:
            print(f"\n{len(drift)} file(s) differ from the site: {', '.join(drift)}")
            print("Run tools/sync-assets.py to bring the bundle forward.")
        else:
            print("\nall %d files match the site's current bytes" % len(FILES))
    return drift


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-url", action="store_true", help="pull from https://moddys.net")
    ap.add_argument("--site", default=None, help="local site folder to copy from")
    ap.add_argument("--check", action="store_true", help="compare with the site, change nothing")
    a = ap.parse_args()

    site = None
    if a.from_url:
        if a.check:
            print("--check with --from-url: nothing local to compare, listing only")
            report(None)
            return 0
        print(f"syncing from {LIVE}")
        from_url(DEST)
        report(None)                 # no local site to compare against on this path
        return 0
    else:
        site = find_site(a.site)
        if not site:
            print("Could not find the site folder. Pass --site DIR or --from-url.", file=sys.stderr)
            return 1
        print(f"syncing from {site}")
        missing = [f for f in FILES if not os.path.isfile(os.path.join(site, SOURCE_OF.get(f, f)))]
        if missing:
            print(f"  missing in source: {', '.join(missing)}", file=sys.stderr)
            return 1
        if not a.check:
            os.makedirs(DEST, exist_ok=True)
            for name in FILES:
                with open(os.path.join(DEST, name), "wb") as f:
                    f.write(source_bytes(site, name))
                print(f"  copied {name}")
            for name in DIRS:
                src_dir = os.path.join(site, name)
                if os.path.isdir(src_dir):
                    shutil.copytree(src_dir, os.path.join(DEST, name), dirs_exist_ok=True)
                    print(f"  copied {name}/")

    drift = report(site)
    return 1 if (a.check and drift) else 0


if __name__ == "__main__":
    sys.exit(main())
