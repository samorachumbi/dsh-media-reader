# Build lessons — every defect this plugin taught us, and the gate that now prevents it

This plugin was built, packaged, published and put on sale in one long session. Almost none of the defects
below were in the reading code. They were in **the packaging, the claims and the measuring** — the parts a user
only meets when something is already wrong.

Each entry is: **what happened → the rule → the guard**. If a rule has no guard, it will be broken again.

## 1. Claims must be derived from the check that ran

- **`install.sh` printed "installed." after warning it could not import the plugin.** The sentence was doing
  work the check had not done. → The summary is now derived from a `VERIFIED` flag: *"installed, and the import
  check passed."* only when the import check passed, otherwise *"COPIED, BUT NOT VERIFIED — do not treat this
  as working."*
- **A `--dry-run` printed that same success sentence**, because the flag was initialised before the dry-run
  branch. A no-op satisfied the only pass condition the docs stated. → A dry run now says *"dry run — nothing
  was changed, and nothing was verified."*
- **`uninstall.sh` printed "patch row removed" while the row survived**, because its pattern required a
  comment header a hand-written row does not have. → The block is matched by plugin name, the message is
  conditional, and an unremovable row exits non-zero and says so.
- **A shell comment claimed the script would "refuse" a case it cannot even detect.** → It now says it warns.

**Guard:** `install.sh` (`VERIFIED`), `uninstall.sh` (conditional exit), and a reviewer question for every new
sentence: *which line of code makes this true?*

## 2. Never take a home from the environment when the user named one

`install-skills.sh` read only `$DSH_HOME`, and a harness sets that variable in **every** process it spawns — so
`./install.sh --home /tmp/scratch && ./install-skills.sh` installed the plugin into `/tmp/scratch` and the
skills into the operator's real home. Silent, and hard to undo.

**Guard:** `--home` on every installer, the resolved target printed, and a NOTE when it falls back to the
environment.

## 3. State the preconditions, or the first command fails

On a home DSH has never run in, the installer refuses (`profile directory not found`) — and `--profile` does
not create the directory. Worse, a hand-made directory lets it *print "installed"* while warning that the
plugin cannot be imported. A runnable install needs: `<profile>/package.json` with `dsh.profile.bundles`,
`cordis.yml`, `profiles/node_modules`, **and model credentials** (without them the smoke test dies on check 1
of 18).

**Guard:** an explicit precondition step in the generated instructions, and a smoke test that refuses a dead
port instead of failing 18 times.

## 4. A failing check must explain itself

When no tool ever ran — missing credential, rejected model — the tool output was empty, so the smoke test
printed a **blank detail line** while the instructions said "paste the output back". The cause was sitting in
the turn's error events, discarded.

**Guard:** the failure path extracts the cause from the event stream and prints it.

## 5. Ship a licence inside the artifact

The repo had terms; the tarball granted nothing, because `LICENSE` did not exist when it was built and the
build never copied one.

**Guard:** `LICENSE` and `plugin/LICENSE` are required files — the build fails without them.

## 6. Bytecode and private paths travel into artifacts

A stale `__pycache__/*.pyc` shipped with the author's absolute path compiled into it. A text scrubber cannot
rewrite a `.pyc`, and stale bytecode can shadow a source change on the buyer's machine.

**Guard:** the build deletes bytecode, then proves the staged tree contains no home path, no credential and no
`.pyc` — and refuses to ship if it does.

## 7. Test the call the product makes, not a convenient equivalent

The path scrubber was refactored to read its private locations from the environment. A test passed — but it
passed the variables **by hand**, while the build script only *sourced* them into shell variables without
exporting them. The real build silently stopped scrubbing. The same session's installer bug (§2) was the same
shape: the test never exercised the path a customer takes.

**Guard:** the release check is a diff of the new payload against the previously verified artifact, not a unit
test of a function in isolation.

## 8. Check presence as well as absence

A sanitiser stripped machine-specific references from the shipped skills. It dropped every section whose
heading mentioned "this machine" — including **"Install — NEVER with `dsh plugin add` on this machine"**, which
carried the ban on the one command that can brick a harness. Every absence check was green; the document had
become clean and useless.

**Guard:** the build now fails if a shipped skill *still refers to something unshipped* **and** if it has
*lost a line a customer needs*.

## 9. Measure in exact CSS pixels

With mobile emulation on, Chrome scales the visual viewport, so `scrollWidth === innerWidth` even when the page
overflows. A 356 px `<code>` element pushed a 320 px layout to 412 px and the check reported "no overflow".

**Guard:** all layout measurement runs with `mobile: false`.

## 10. A screenshot nobody checked is not evidence

Three separate instrument defects in one session: screenshots taken before the navigation committed (900 px
strips); a silent `Math.min(height, 6000)` ceiling that truncated two full-page captures; and a clip computed
from viewport-relative coordinates **after** a scroll, which photographed the wrong section entirely.

**Guard:** wait for `readyState === 'complete'` plus a real element; never cap silently; read the PNG header
back and throw if the pixels do not match the measured page.

## 11. Assert the specific thing, not a shape that is already true

A test waited for the string "your file" — which was already present from the previous case — so it read stale
content and passed. Another hardcoded a sha256 and failed the page for being correct after a rebuild.

**Guard:** assertions name the exact expected value, and facts like hashes are **read from the artifact at
runtime**, never typed into the test.

## 12. Prove a guard can fail

A new check was "verified" by mutating it into something vacuously true, which proved nothing. The same check
mattered for the demo race: the initial render used a 700 ms timer that overwrote the visitor's own file; the
regression test only became trustworthy after the timer was reintroduced in a throwaway copy and the test was
watched failing on it.

**Guard:** every new guard gets one run against the defect it exists to catch.

## 13. Never `stopPropagation` on an event the host also needs

The composer drop handler called `stopPropagation()` in its capture-phase listener, so DSH's own drop logic
never saw the event. Installing the plugin **stopped the composer accepting media**.

**Guard:** `preventDefault()` only (so the browser does not navigate to the file); the event propagates, so the
host still attaches the file **and** the plugin still inserts its reading. Verified on a live server: a real
drag produced a `blob:`-backed thumbnail *and* the inserted text.

## 14. Progressive enhancement is a promise, not a style

The purchase area was rendered entirely by script, so with JavaScript off a sales page showed a price and no
way to act on it — and the footer's contact links were `href="#"` until script filled them.

**Guard:** the buy area is tested in three states (scripting off, on with no payment rail, on with a rail).

## 15. A payment button needs a payment that happened

A payment method renders only when it has both a hosted-checkout URL **and** a `verified` date — the date a live
payment was actually seen through it. Also worth knowing: "accepts PayPal" is three different things. One
provider's PayPal is a **stablecoin rail (PYUSD)** that a buyer with a card linked to PayPal cannot use, and
another could not be verified at all. Verify the method list in the provider's own hosted checkout, never in its
marketing.

## 16. Derive facts, never encode them

Hashes, ports and paths went stale three separate times in one session — a hardcoded sha256 in a storefront, a
hardcoded CDP port in a test harness, a hardcoded stopped-server port in a sweep. Every one produced a failure
that looked like a product bug.

**Guard:** the environment supplies ports; the artifact supplies hashes.

## 17. Model-facing text is user-facing text

The `<artifacts>` element of an audio or video result printed absolute paths — `/home/<user>/artifacts/…`.
Those results are also what the drag-and-drop route inserts into the composer draft, and a draft is text a
human sends, pastes into a ticket or photographs. So the plugin's own reading quietly published the user's
directory layout. Image drops were unaffected, which is exactly why it survived: the defect existed in two of
three modalities, so two of three hand-tests looked clean.

The disclosed fix was "relativise client-side". That was the wrong layer — the same text is *also* what the
model reads, so a browser-side transform would have left the host route, the storefront demo and any future
consumer leaking.

**Guard:** one helper renders artifact references relative to the artifacts root (a path outside it is reduced
to its file name), the resolver gained a matching fallback so a printed reference still opens the file, and
`tests/draft-paths.test.mjs` asserts both halves — no absolute path in the text, *and* the printed reference
resolves back to the real file. A wiring assertion covers the third failure mode unit tests cannot see: a
caller that forgets to pass the root.

---

## The rule behind the rules

Every defect that recurred had a **rule with no enforcement**. The durable fixes were gates that fail a build
or a test — not sentences in a document. When you add a rule here, add the thing that fails when it is broken,
and show it failing.
