#!/usr/bin/env python3
"""Issue a commercial licence document for one order — the fulfilment step the storefront promises.

The storefront's FAQ says a buyer receives "the download plus your licence reference". Until this script
existed, nothing produced that document, so the page made a promise with no mechanism behind it.

    python3 tools/issue-licence.py --buyer "Acme Ltd" --email ops@acme.test --order FLW-1234567

Writes `licences/<order>-<slug>.md` and prints the line to paste into the reply email. The document names the
exact artifact it covers (version and sha256) so the licence cannot silently drift to a later build.

`licences/` is gitignored on purpose: these files carry a buyer's name and email, and this repository is
public. Never commit one.
"""
import argparse
import datetime as dt
import json
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = ROOT / "licences"


def artifact_identity() -> tuple[str, str]:
    tarballs = sorted(DIST.glob("*.tar.gz"))
    if not tarballs:
        raise SystemExit(f"no built artifact in {DIST} — run dist-tools/build-bundle.sh first")
    tarball = tarballs[0]
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    sidecar = (DIST / (tarball.name + ".sha256"))
    if sidecar.is_file():
        recorded = sidecar.read_text().split()[0].strip()
        if recorded != digest:
            raise SystemExit(
                "REFUSING: the .sha256 beside the artifact does not match its bytes "
                f"({recorded[:16]}… vs {digest[:16]}…). Rebuild before issuing a licence."
            )
    version = re.sub(r"^dsh-media-reader-|\.tar\.gz$", "", tarball.name)
    return version, digest


def main() -> int:
    ap = argparse.ArgumentParser(description="Issue a commercial licence for one paid order.")
    ap.add_argument("--buyer", required=True, help="the legal name the licence is granted to (team or company)")
    ap.add_argument("--email", required=True, help="the address the payment was made with")
    ap.add_argument("--order", required=True, help="the payment provider's reference, e.g. FLW-1234567")
    ap.add_argument("--date", default=None, help="issue date YYYY-MM-DD (defaults to today)")
    args = ap.parse_args()

    version, digest = artifact_identity()
    issued = args.date or dt.date.today().isoformat()
    slug = re.sub(r"[^a-z0-9]+", "-", args.buyer.lower()).strip("-")[:40] or "licensee"
    ref = re.sub(r"[^A-Za-z0-9-]+", "-", args.order).strip("-") or "order"

    doc = f"""# Commercial licence — dsh-media-reader {version}

**Licensor:** Itikia Digital Solutions, Nairobi, Kenya
**Licensee:** {args.buyer} ({args.email})
**Order reference:** {args.order}
**Issued:** {issued}
**Covers this artifact exactly:** `dsh-media-reader-{version}.tar.gz`
**sha256:** `{digest}`

## What is granted

A non-exclusive, non-transferable, perpetual licence to **use** dsh-media-reader {version} for commercial
purposes, including inside a company's internal revenue-earning workflow and as a component of a product or
paid service the Licensee delivers. This includes updates published within **12 months** of the issue date.

One licence covers one team: every machine that team uses, not other companies.

## What is not granted

- **No redistribution.** The Licensee may not publish, sublicense, sell or give away the plugin, the bundle or
  a derivative of them, in whole or in substantial part.
- **No competing product.** The Licensee may not use it to build a product whose primary purpose is to replace
  it.
- **No removal of notices.** The copyright and licence notices must remain intact.

## Terms that travel with the artifact

The full terms are the `LICENSE` file inside the bundle; where this document and that file differ, that file
governs. Third-party components keep their own licences (ffmpeg, faster-whisper and its model weights, and the
DeepSeek Harness packages) and are unaffected by this grant.

## Verification

The artifact covered is identified by the sha256 above. `MANIFEST.json` inside it lists every file with its own
hash, so the Licensee can confirm that what they received is what this licence covers.

---

Issued by: ______________________  Date: {issued}
Itikia Digital Solutions · hello@itikia.co.ke
"""

    OUT.mkdir(exist_ok=True)
    path = OUT / f"{ref}-{slug}.md"
    path.write_text(doc, encoding="utf-8")

    print(f"licence written: {path}")
    print("paste this into the reply:")
    print(f"  Your commercial licence for dsh-media-reader {version} is attached — order {args.order}, "
          f"covering artifact sha256 {digest[:16]}…")
    if not (ROOT / ".gitignore").is_file() or "licences/" not in (ROOT / ".gitignore").read_text():
        print("WARNING: `licences/` is not gitignored — these files carry buyer details and this repo is public",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
