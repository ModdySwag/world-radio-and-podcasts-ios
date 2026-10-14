#!/usr/bin/env python3
"""Keep the shell files this app shares with the Android app identical to the Android copy.

`_shell_shim.js` is ONE file - the player sheet, the gesture handling, the theme, the
visualiser, the compatibility panel and the bridge adapter that hides the difference between
Android's synchronous JS interface and iOS's message handler. Both apps ship it.

Editing it separately in each repo would mean shipping two apps that look the same and behave
differently, so it is edited in the Android repo (where it grew up) and copied here.
`SHIM.sha256` records the revision this app carries, in sha256sum format, so plain
`sha256sum -c SHIM.sha256` proves it - in CI, without the other repo present.

Usage:
    python3 tools/sync-shim.py --from ../world-radio-android
    python3 tools/sync-shim.py --check
"""
import argparse
import hashlib
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)

# source path in the Android repo -> path in this repo
SHARED = [
    ("app/src/main/assets/www/_shell_shim.js", "Resources/www/_shell_shim.js"),
    ("tools/shim_harness.py", "tools/shim_harness.py"),
]

RECORD = os.path.join(PROJECT, "SHIM.sha256")


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_record():
    lines = []
    for _, target in SHARED:
        full = os.path.join(PROJECT, target)
        lines.append("%s  %s\n" % (digest(full), target.replace(os.sep, "/")))
    with open(RECORD, "w", encoding="utf-8", newline="\n") as f:
        f.writelines(lines)
    print("recorded in SHIM.sha256:")
    for line in lines:
        print("  " + line.strip())


def check():
    if not os.path.isfile(RECORD):
        print("SHIM.sha256 is missing - run tools/sync-shim.py --from <android repo>",
              file=sys.stderr)
        return 1
    bad = 0
    for line in open(RECORD, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        want, target = line.split(None, 1)
        full = os.path.join(PROJECT, target)
        if not os.path.isfile(full):
            print("  MISSING %s" % target)
            bad += 1
            continue
        got = digest(full)
        ok = got == want
        print("  %s %s" % ("ok  " if ok else "CHANGED", target))
        if not ok:
            print("      recorded %s\n      actually %s" % (want[:16], got[:16]))
            bad += 1
    if bad:
        print("\n%d shared file(s) differ from the recorded revision." % bad, file=sys.stderr)
        print("The Android app's copy is the source of truth: run "
              "tools/sync-shim.py --from <android repo> and commit.", file=sys.stderr)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="source", default=r"C:\Users\Moddy\world-radio-android",
                    help="path to the world-radio-android checkout")
    ap.add_argument("--check", action="store_true",
                    help="verify against SHIM.sha256 instead of copying (no other repo needed)")
    a = ap.parse_args()

    if a.check:
        return check()

    if not os.path.isdir(a.source):
        print("no Android checkout at %s" % a.source, file=sys.stderr)
        return 1

    for source_rel, target_rel in SHARED:
        source = os.path.join(a.source, source_rel)
        target = os.path.join(PROJECT, target_rel)
        if not os.path.isfile(source):
            print("missing in the Android repo: %s" % source_rel, file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
        if target_rel.endswith(".py"):
            # Source files live as LF in this repo and SHIM.sha256 pins BYTES: a copy taken
            # straight from a Windows checkout (CRLF) would be pinned CRLF and then fail
            # CI's LF checkout. Normalise the text on the way in.
            with open(target, "rb") as f:
                data = f.read()
            if b"\r\n" in data:
                with open(target, "wb") as f:
                    f.write(data.replace(b"\r\n", b"\n"))
        print("copied %s -> %s" % (source_rel, target_rel))

    write_record()
    print("\nBoth apps now ship the same shell. Run the harness to prove it still works:")
    print("  python3 tools/shim_harness.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
