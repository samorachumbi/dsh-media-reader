#!/usr/bin/env python3
"""Write MANIFEST.json for a built bundle: every file, its size and sha256, plus role notes."""
import hashlib, json, sys
from pathlib import Path

root = Path(sys.argv[1])
if not root.is_dir():
    raise SystemExit(f"not a directory: {root}")

files = []
for path in sorted(root.rglob("*")):
    if not path.is_file():
        continue
    rel = path.relative_to(root).as_posix()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files.append({"path": rel, "bytes": path.stat().st_size, "sha256": digest})

required = {
    "plugin/lib/index.js": "plugin entry — registers the five tools",
    "plugin/package.json": "package metadata; dsh.client.platform mounts the drag-and-drop half",
    "plugin/cordis.patch.yml": "the profile patch row that loads the plugin",
    "plugin/python/dsp_worker.py": "local DSP worker (tempo, chroma, onsets, chords, loudness)",
    "plugin/probe/smoke.mjs": "live capability harness — drives real sessions on both routes",
    "install.sh": "copy-restore installer; refuses package managers; runs the duplicate guard",
    "install-skills.sh": "links the bundled skills into $DSH_HOME/skills",
    "uninstall.sh": "reverses install.sh and nothing else",
    "smoke.sh": "one-command live verification",
    "skills/product-motion-studio/SKILL.md": "the production method this bundle is built around",
    "skills/dsh-plugin-install-safety/SKILL.md": "why `dsh plugin add` is banned here; the copy-restore method",
    "skills/dsh-skill-install/SKILL.md": "how to make the skills loadable and slash-invocable",
    "skills/dsh-test-boot/SKILL.md": "boot a scratch instance before restarting the real server",
}
present = {f["path"] for f in files}
missing = [p for p in required if p not in present]

manifest = {
    "name": "dsh-media-reader",
    "version": json.loads((root / "plugin/package.json").read_text())["version"],
    "summary": "Read images, audio and video from DeepSeek Harness, including on a model route that cannot accept media.",
    "install": {
        "steps": ["./install.sh", "./install-skills.sh", "restart the DSH server", "DSH_TEST_URL=http://127.0.0.1:3096 ./smoke.sh"],
        "rollback": "./uninstall.sh",
        "package_manager": "none — copy-restore by design; see skills/dsh-plugin-install-safety",
        "requires": ["node", "ffmpeg", "python3"],
    },
    "roles": required,
    "missing_required": missing,
    "file_count": len(files),
    "total_bytes": sum(f["bytes"] for f in files),
    "files": files,
}
(root / "MANIFEST.json").write_text(json.dumps(manifest, indent=1) + "\n")
print(json.dumps({"file_count": manifest["file_count"], "total_bytes": manifest["total_bytes"], "missing_required": missing}, indent=2))
