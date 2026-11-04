---
name: product-motion-studio
description: 'Plan, produce and verify evidence-led SaaS, service and product websites, UI motion, launch explainers and short-form campaigns. Use for website visual audits, SaaS hero and product-demo design, motion graphics, storyboards, scripts, Remotion or DOM animation, kie.ai image or video production, short-form repurposing, and replacing Higgsfield workflows with portable alternatives.'
---

# Product Motion Studio

Build the **smallest visual system that lets a visitor understand, believe and act**. A beautiful
clip that does not show what the offer does is decoration, not product communication.

This skill combines website evidence design, product UI motion, launch explainers, generated visual
assets, short-form packaging and production ledgers. It is vendor-neutral. **kie.ai is the current
paid-generation adapter; Higgsfield is an optional later adapter, never a dependency.**

## What this skill is not

- Not a licence to invent a SaaS dashboard for a service business.
- Not a video-generator prompt collection. Story, evidence, assembly and verification come first.
- Not a replacement for `ui-ux-pro-max` (design decisions), `scroll-craft` (scroll-page construction
  before installing packages or connectors).
- Not an autopublisher. Nothing goes to prospects, social accounts or ad platforms without explicit
  operator approval.

## Production invariants (learned from a paid, visually-reviewed pilot — 2026-11-01)

These are process requirements, not style suggestions. They apply to people, animals, products,
architecture, food, vehicles and any other generated subject.

1. **Research before implementation, and pin the object.** Read official provider documentation at run
   time, then practitioner evidence. Record what was read, when, and what could not be read. Search
   summaries are not full-text evidence; inaccessible Reddit/HTML is `UNVERIFIED`, not “the community
   says”.
2. **Fix the brief and acceptance criteria before the first paid call.** A prompt may express intent; it
   cannot be the acceptance test. Write measurable PASS/FAIL gates for identity, anatomy, wardrobe,
   background, framing, motion, duration, audio and spend.
3. **Do not treat a provider success as a visual pass.** Inspect actual native-resolution output through a
   vision-capable route. Record the verdict and rejected artifacts before spending on the next level.
4. **One paid variable per experiment.** Change the model, reference, crop or prompt one at a time.
   Classify the defect first. A blind retry is not a method; a second model is not automatically a fix.
5. **Separate structural edits from small-anatomy edits.** Use full-frame single-render edits for
   garments, products, scene structure and large objects. Use a close-up crop for hands, hair tips, eyes,
   labels, text, jewellery and other small features. Never ask a full-frame prompt to repair a tiny
   feature it cannot resolve.
6. **Match aspect ratio before any resize.** Reject a returned aspect outside tolerance; never stretch
   it to fit. Use one uniform scale and translate only. Preserve originals.
7. **Composite with subject-fitted masks, not broad shapes.** Broad ellipses/rectangles create halos,
   preserve old content and darken people. Feather outward only; keep subject pixels bit-identical;
   restore protected features after pasting.
8. **Prove grading preserves colour and subject.** A luminance `geq` operation can silently desaturate a
   whole clip. Grade RGB proportionally, measure channel spread, subject exposure and mask-edge steps.
   Metadata without those measurements is not acceptance.
9. **Move identity → minimal motion → simple movement → complex action.** Test a short locked clip
   first. Review all frames, not a contact sheet alone. Never make a crowd, dance or fight the first
   temporal test.
10. **Build from independent layers.** Background/location, each recurring subject, props, atmosphere and
    typography are separate assets joined in Remotion/ffmpeg. No ensemble generation for recurring
    identities; no generative person-to-cloud or object-to-object morphs; no optical-flow identity blends.
11. **Archive everything with provenance.** Source, task ID, prompt revision, actual credits, input hashes,
    output paths, rejection verdicts and review location. The operator's review directory and the project
    archive both receive the file; provider URLs are never the only copy.
12. **Budget is a gate, not a warning.** Project `actual + next estimate`; stop and request explicit
    extension before exceeding the ceiling. Include expected revisions. Failed/unbilled jobs still get a
    ledger row with actual 0 and the provider reason.
13. **Keep the skill honest.** Promote a technique into this file only after it passes a real visual gate.
    Keep a rejected-techniques list. Do not convert one lucky output into a universal claim.
14. **Design for adaptation.** No hardcoded subject, body, language, aspect, path, review port or provider
    model in production scripts. Parameterize these; keep the invariant the same while the subject changes.

## Authority and truth

1. **The operator and project documents own the offer, claims, budget, language and creative
   decisions.** Vendor documentation owns API mechanics. Neither may overwrite the other.
2. Create `FACTS.md` before copy or generation. Every product claim, price, number, testimonial and
   result needs a named source and date. **A fact without a source does not enter the brief, script,
   storyboard or page.** Mark unknowns instead of filling them with plausible prose.
3. Label every visual by provenance:
   - `REAL_CAPTURE`: actual product, service, location or client-supplied evidence.
   - `DEMO_RECONSTRUCTION`: a truthful interaction rebuilt in DOM/SVG/Remotion, visibly labelled
     `Demo`, `Illustrative workflow`, or `Sample data` as appropriate.
   - `GENERATED_ILLUSTRATION`: AI-created atmosphere or conceptual imagery. Never call it a product
     screenshot, customer, result or case study.
   - `CLIENT_SUPPLIED`: an asset whose owner and permitted use are recorded.
4. Do not invent users, clients, reviews, analytics, income, savings or product capabilities. Do not
   present an illustrative before/after as measured performance.
5. Voice cloning, faces, interviews, customer footage and logos require recorded permission and an
   allowed-use check. Medical, legal and financial advice claims need specialist review, not a more
   confident prompt.
6. Keep secrets server-side. Never expose a KIE or Higgsfield key in browser code, a public repo or a
   screenshot. Do not rewrite credential files; append only what is intentionally changing.

## Step 0: Reuse the brief, then fill only its gaps

Read existing project facts, brand assets and prior decisions first. Do not restart an interview that
has already happened. Record `BRIEF.md` with:

- offer, audience, buyer's situation and the one sentence they must remember;
- the visitor's next action, with one CTA label reused everywhere;
- deliverables: website section, background loop, click-to-play explainer, launch film, long-form
  video, vertical cutdown, thumbnail set, or a campaign;
- actual product/service behaviour and what can be shown as `REAL_CAPTURE` versus only as a demo;
- supplied UI, screenshots, footage, logo, fonts, colours, references and usage rights;
- language(s), aspect ratios, accessibility needs, deadline and **spend ceiling**;
- one core visual mechanic: a single idea the viewer can restate, not a pile of effects.

If the offer is a **productized service**, show `customer input -> service action -> human control or
handoff -> delivered artefact`. Do not force it into a fictional self-serve SaaS interface.

## Step 1: Route by evidence and fidelity, not by vendor

| Requirement | Default route | Why |
|---|---|---|
| Website hero or section that must explain a real workflow | **Semantic DOM + CSS/JS**, using `scroll-craft` when scroll-driven | Crisp real text, accessible controls, easy iteration, no generated UI drift |
| Exact UI animation, launch film or explainer | **Remotion + real UI assets** | Deterministic frames, editable copy/data, precise camera and repeatable cutdowns |
| Truthful product proof | **Real screenshot or screen recording**, optionally annotated in DOM/Remotion | Authenticity matters more than vector purity |
| Photoreal product, people, location or atmospheric cutaway | **kie.ai**, with supplied references where available | Generative imagery is strongest where exact UI is not the evidence |
| Highly controlled camera/motion study | kie.ai image-to-video or reference-to-video after a small pilot | Capability and quality vary by model; test before a batch |
| Long-form faceless explainer | research + script blocks + generated/narrated blocks + Remotion/ffmpeg assembly | Audio and visuals stay independently revisable |
| Short-form content | **Recut a proven master first**, then generate missing shots | Reuse evidence and avoid producing disconnected volume |
| Brand film where a vendor's distinct look is explicitly wanted | Optional Higgsfield adapter after approval | An upgrade choice, not a workflow prerequisite |
| Finding buyers or planning cold outreach | Hand off to `outreach-planner`; keep production and acquisition separate | Physical-product ads and SaaS/service explainers are different offers |

**Code is the default for product truth. Generation is the default for atmosphere.** A real screenshot
is welcome when it is evidence; SVG/DOM is preferable when the same UI must be animated, zoomed or
revised. The inherited rule "never use screenshots" is therefore rejected as an absolute.

## Step 2: Build the evidence map before the moodboard

Write `EVIDENCE-MAP.md`. Every important visual gets one job: **explain, demonstrate, prove, orient,
or create emotion**. Emotion may support the sale; it may not silently replace the other four.

For a website, the first screen should let a new visitor answer:

1. What is being offered?
2. Who is it for?
3. What problem does it solve or outcome does it produce?
4. What does using it actually look like?
5. What should I do next?

Use a product or service surface near the hero: a real interaction, a labelled demo, an annotated
workflow, or a delivered-artefact preview. A cinematic background is optional and subordinate.

Recommended evidence sequence, adapted to the offer rather than applied as a rigid template:

1. **Recognition:** the buyer's actual situation.
2. **Demonstration:** input and the service/product acting on it.
3. **Control:** approval, exception handling or human handoff where it exists.
4. **Delivered artefact:** the report, booking, updated profile, page, export or other real output.
5. **Scope and limits:** what is included, excluded and still a demo.
6. **Action:** one resolving CTA.

Use `ui-ux-pro-max` for design-system decisions and `scroll-craft` for page grammar, scroll mechanics
and its verification loop. Do not replace a page with a generated picture of a page.

## Step 3: One storyboard, several render projections

`STORYBOARD.md` is authoritative. A generated storyboard image is only a review derivative, never the
source of truth. Use one row per shot/block:

| id | start/end | purpose | on-screen action | exact overlay/narration | fact source | provenance | motion/camera | audio | acceptance check |
|---|---|---|---|---|---|---|---|---|---|

Rules:

- Choose duration from the reading and demonstration load. Do not force every asset into 5, 10, 15 or
  30 seconds. Keep important copy readable; roughly 1.5 seconds is a starting check, not permission
  to rush longer text.
- A launch explainer normally covers `hook -> problem -> product action -> payoff -> CTA`. Cut any
  scene that serves none of these.
- Use **one core mechanic** per film and one identity anchor per recurring invented object or style.
- Keep an exact `COPY LIST`. Render headings, captions, labels, numbers and logos in HTML, Remotion or
  the edit layer. Do not ask a video generator to typeset critical text.
- A storyboard grid may be generated in one image for cheap visual review, but labels and timing stay
  authoritative in `STORYBOARD.md`.
- Name the riskiest element and a simpler Plan B before generation: fewer tracked people, fewer
  locations, a cut instead of a continuous morph, or a real UI card instead of particles.
- Plan 16:9, 9:16 and 1:1 as **recompositions**, not centre crops. Record safe zones and what moves
  or changes in each version.

### Short-form compression

Open on the payoff or unresolved customer situation in the first 0–3 seconds. Plant one specific open
loop, show concrete product/service action, close that loop, then give one CTA. Do not create several
competing hooks. Captions are real text in the edit, with a transcript for spoken content.

### Long-form narration

When a long explainer is actually requested, use the research grid as a starting point: about six
8–10-second narration blocks per minute, one idea per block, approximately 20–24 spoken words each.
Cold-open on the result, organise chapters around questions, track every open loop and close all of
them. Adjust the grid to the real recording instead of padding to a quota.

Keep two artifacts: a human `SCRIPT.md` with chapters and loop annotations, and a machine-readable
`BLOCKS.md` containing `NARRATION`, `VISUAL`, `SOURCE` and `DURATION` per block.

## Step 4: Create a portable look kit

Create `LOOK-KIT/` and `LOOK-KIT.md` containing:

- approved logo/brand assets and usage constraints;
- palette roles and typography, with contrast verified in the final render rather than assumed;
- one style preamble reused verbatim across generated assets;
- one reference plate or style swatch, plus the identity anchor for recurring subjects;
- product/UI reference files and the exact aspect ratio required by each deliverable;
- allowed motion language and prohibited effects.

A style reference may guide line, finish, grade and palette. It must not silently import another
brand's text, characters or layout. **Check the reference's aspect ratio and content before attaching
it to a batch**: one wrong reference can make an entire campaign consistently wrong.

## Step 5A: Website and DOM motion

- Ship semantic HTML with real headings, copy, links and reading order. Never bake essential copy into
  generated imagery.
- Motion should explain state, causality, hierarchy or depth. Animate `transform` and `opacity`; use
  `clip-path` deliberately. Do not animate everything or keep text and CTAs moving merely because
  "nothing should ever stop".
- Provide `prefers-reduced-motion` behavior and a complete static composition. No clip needs to be
  fetched for a decorative sequence under reduced motion.
- Auto-starting motion that lasts more than five seconds alongside other content needs a pause, stop
  or hide mechanism unless it is genuinely essential. Do not use strobing or repeated full-frame
  flashes. See [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).
- Background video is muted, has no essential audio-only information, uses a poster from its own first
  frame, and is recomposed for portrait rather than blindly cropped. Spoken explainers get captions
  and a transcript.
- Set a media-byte budget before encoding and measure the delivered files. Do not use a high-CRF,
  60 fps production master as an above-the-fold web asset. Lazy-load below-fold video; `preload="none"`
  is appropriate for user-initiated playback. See [web.dev video loading](https://web.dev/articles/lazy-loading-video).
- Test keyboard focus, contrast on the composited page, mobile overflow and intermediate scroll/render
  states. For gradient-masked text, assert the text ink fits the element's own background box; a
  normal page-overflow check cannot see missing paint.

## Step 5B: Deterministic Remotion explainers

Use this route when exact UI, copy, data or revisions matter.

- **Every frame is a pure function of its frame number.** Drive animation with `useCurrentFrame()` and
  interpolation/springs, not wall-clock timers or CSS animations. This is also
  [Remotion's own rendering guidance](https://www.remotion.dev/docs/troubleshooting/css-animations).
- Keep copy, colours, durations and data in one configuration object. Build shared camera, cursor,
  counter and scene components. A revision should change data, not require a regeneration.
- Load fonts before frame zero. Render a key still for every scene and inspect scene boundaries before
  rendering video. Check fallback fonts, collisions, clipping and chart geometry.
- Useful starting grammar, to be tuned rather than worshipped: eased entrances with a small overshoot;
  faster exits; stagger related items by a few frames; overlap transitions slightly; use arced cursor
  travel and subtle click presses; keep camera moves slow enough to read.
- Stillness is allowed, especially for reading and CTA holds. Use subtle drift only when it improves
  depth and reduced-motion is not requested.

### Identity preservation and local repair (verified 2026-11-01)

Use this when a generated person must remain recognisable and anatomically coherent across shots. These
rules come from an actual pilot with repeated visual-gate failures followed by accepted results; they are
not prompt folklore.

1. **Progress from identity → minimal motion → simple movement → complex dance.** Do not make the first
   motion test an adumu, fight scene or crowd. Keep the first clip short and locked, and review the whole
   clip before spending on the next level.
2. **Use full-frame single-render edits for structural clothing.** A full-frame garment repair needs no
   mask and avoids crop/paste seams, ghost bands and anisotropic registration. Preserve the input plate and
   record `input.prompt`, model, task ID, actual credits and output paths.
3. **Use field of view for small anatomy.** When fingers, hair tips or other small features fail, give the
   model a close-up of that feature rather than asking it to repair a tiny region in a full-body image.
   Close-ups are not inherently moderation-blocked: a hand/forearm-only crop passed, while a different
   shoulder/hair crop was rejected. Inspect content instead of generalising either outcome.
4. **Match crop and output aspect before any resize.** Reject mismatched returns instead of stretching
   them. A 2:3 crop needs a 2:3 output; a 1:1 crop needs a 1:1 output. Crop provider padding only after
   checking dimensions, then use one uniform scale.
5. **Composite only the intended feature.** Use an anatomical or elliptical mask with exact registration,
   small edge feathering and tone matching. Never use rectangular protection or a broad rectangular feather:
   those preserve old clothing and create new patches. Restore hands/armbands after pasting when required.
6. **Do not let an optimiser invent registration.** Lock to an accepted frame rather than allowing a metric
   to erase detail or shift the subject. Reject when measured registration is outside the approved tolerance.
7. **Keep master identity and evidence.** One reference pack per recurring character: identity portrait,
   neutral full-body, outfit, props and distinct mannerisms. Preserve every rejected artifact and verdict;
   do not chain edits until the current plate passes. Each new stage re-anchors to the accepted master.
8. **Make visual acceptance independent of provider success.** Review native crops and dense motion bursts
   through an image-capable route. Check identity, proportions, garment, accessories, background, metadata
   and actual spend. Zero outside-mask differences is necessary but never sufficient.
9. **Do not use automatic skin segmentation as a default repair.** Colour/chroma alone can erase strands or
   preserve body-shaped artifacts. If a sensitive-input flag appears, inspect the actual content and prior
   accepted inputs before changing anatomy or assuming a cause. A no-op cover is not a test.
10. **Archive every generated still/video in the operator's review location and in the project.** Keep the
    original and repaired versions with descriptive titles and immutable provenance. A provider URL is never
    the only copy.

### Anti-slop taxonomy — identify the class before choosing a fix

| Failure | What it looks like | Preferred first fix |
|---|---|---|
| Identity blending | Two faces drift toward an average face | Separate identity references; one recurring subject per generative layer |
| Identity swapping | A prop/hair/outfit moves between characters | Distinct silhouettes/wardrobe anchors; compare each subject against its own master |
| Duplication | A reference sheet is copied literally; the same person appears twice | Count all subjects in every frame; use one subject per gen layer |
| Scale drift | Child/adult or product proportions change between shots | Lock canonical dimensions; group/composite only after accepted plates |
| Anatomy fusion | Fingers weld, feet merge, limbs lose joints | Close-up feature crop; larger native resolution; inspect native pixels |
| Wardrobe/accessory drift | Ties, piping, logos, headbands appear or vanish | Full-frame structural repair; category-level exclusion (“no jewellery except…”), not item shopping lists |
| Framing drift | Head/foot cropped, wrong aspect, silhouette moves | Deterministic aspect gate; uniform scale; pad only background edges |
| Mask artifacts | Rectangular patches, halos, ghost bands, subject darkening | Subject-fitted mask; outward-only feather; protected-feature restore; RGB-preserving grade |
| Exposure drift | Backdrop brightens while subject stays flat | Measure backdrop and subject separately; RGB grade outside subject mask; verify saturation |
| Shot-to-shot drift | First shot works, third does not | Re-anchor every stage to accepted master; review at 5–8 s and full clip |
| Motion morph | Person/animal/object becomes another between frames | Short locked clips; no optical-flow identity blends; hard cuts instead |
| Moderation false lead | Provider flags a crop and the team invents an anatomy cause | Compare accepted inputs and inspect actual content; no-op covers are not tests |

### Asset architecture that avoids these failures

- **Reference pack per recurring subject:** clear identity portrait, neutral full-body, outfit sheet,
  prop sheet, mannerism notes. One outfit per sheet; empty hands/props unless intentionally part of the
  look; flat neutral background.
- **Background plate:** empty location, locked camera/light/direction. No recurring subjects baked in.
- **Subject plate:** one generated subject on a plain or matte-friendly background, close to final scale.
- **Feature plates:** close-ups for hands/labels/eyes/texture where the full-body render lacks pixels.
- **Atmosphere/type:** dust, embers, grain, titles and CTA in deterministic layers.
- **Join:** explicit masks and hard alpha where possible; no generative transition between layers. Keep
  original and repaired copies. Freeze an accepted plate before changing anything else.

### Fast production recipe for a generated-subject film

1. Pin sources and provider docs; write `BRIEF.md`, `FACTS.md`, `EVIDENCE-MAP.md`, rights and budget.
2. Build the authoritative storyboard and a distinct master reference pack for each recurring subject.
3. Establish the empty background/location and primary subject still; use full-frame edits for large
   structure and close-ups for small anatomy. Visual gate each pass.
4. Build a **minimal-motion** clip from the accepted subject plate. Review all frames for identity,
   exposure, colour, camera lock and slop. Do not skip to the hero action.
5. Add simple movement, then the complex action. Each level is a separately approved spend.
6. Composite layers in Remotion/ffmpeg; no generative merge between identities, props or atmosphere.
7. Apply deterministic grade/reframe; prove subject pixels unchanged, RGB preserved and no mask halo.
8. Assemble with the real audio/typography; measure duration, codec, aspect, audio and delivered bytes.
9. Reconcile spend and archive every original, rejected and accepted artifact with verdicts.
10. Promote only the proven method to this skill; leave rejected techniques named.

**Candidate fallback, not yet proven:** for hard body mechanics or crowd scenes, build an isolated pose/
motion guide in Remotion or a simple 2D/3D rig, then use a documented motion-control endpoint on one
subject plate. Pilot it like any other method; a guide is not a guarantee of output fidelity.

### Moderation and sensitive-input protocol

1. Quote the provider error and compare it with previous **accepted** inputs; a full plate containing
   more skin may already have passed.
2. Inspect the actual crop before proposing a cause. Do not cover nipples, faces or body regions that are
   not present; a no-op derivative proves nothing.
3. Do not infer a universal rule from one rejection. A hand/forearm close-up can pass while a
   shoulder/hair crop fails; the variable may be framing, not anatomy.
4. If a safe derivative cannot be produced defensibly, stop and ask the operator. Never ship a cosmetic
   mask with a body still visible, and never generate replacement anatomy just to evade moderation.
5. Every failed task is ledgered with actual credits (often 0) and its exact provider message.

### Grading rule for deterministic fixes

- Preserve RGB: scale all channels, never collapse to luminance. Measure channel spread/saturation.
- Protect the subject with a fitted mask; clamp feathering so it cannot bleed inward. Verify subject
  pixels bit-identical to the original.
- Measure the mask edge on flat background; measure backdrop exposure over time and subject exposure
  separately.
- If the fix changes identity, colour or anatomy, reject the fix even when the numerical target (e.g.
  exposure drift) is met.
- A metadata report that cannot detect the defect it is meant to prove is not evidence. Add the missing
  probe or a visual gate.

### Validated deterministic-grade measurement pattern (2026-11-01)

This pattern turned a rejected clip into an accepted one without a new provider call:

1. Build **per-frame subject masks from the clip itself** (dark/red/foreground detection, margin, hole fill).
   Never use one static ellipse/rectangle when the subject moves; in the pilot the head translated ~107 px.
2. Apply an equal-channel gain `out = original × (1 + d(t)·(1−alpha/255))` to RGB. Never use `geq=lum`;
   that converts the clip to grayscale and destroys the identity palette.
3. Clamp the blurred alpha to a dilated core so feathering exists only outward. Raise the protection margin
   until measured subject pixels changed = 0; the pilot needed 28 px.
4. Render the **encoded delivery file**, not just the raw frames, then measure on all frames: subject/vs-original
   difference, channel spread/saturation, backdrop peak-to-peak, mask-edge step vs original, gain step per frame,
   duration and audio stream presence.
5. Set a tolerance that accounts for 8-bit quantisation and report it explicitly. Accept ~1-level flatness only
   when subject/colour/geometry pass; do not claim a finer target than the pipeline can measure. Keep the visual
   verdict separate from the metric pass.
6. Example accepted metrics from the pilot: 121 frames; subject changed ≤0.19 levels; channel spread 163–184;
   backdrop peak-to-peak 0.36–0.90 levels versus 5.95 originally; no new edge; gain step 0.00386; no audio.
7. Do not inherit a still approval for motion. The encoded clip gets its own all-frame temporal verdict.

### Applying identity locks to non-human subjects

| Subject | Identity anchor | Mannerism/functional anchor | Must not drift |
|---|---|---|---|
| Human | face, age, height, hair, skin, wardrobe | posture, gait, hand behaviour | identity, body proportions, wardrobe, small anatomy |
| Animal | species/markings, face, body ratio, coat | movement rhythm, ear/tail behaviour | markings, limb count, face, scale |
| Product | shape, proportions, materials, colours, labels | how it opens/moves/assembles | logo, controls, geometry, finish |
| Architecture | footprint, façade rhythm, materials, scale | people/vehicle scale cues | doors/windows, perspective, structure |
| Food | ingredients, plating, portion, surface | steam/pour/cut behaviour | ingredient count, texture, physics |

### Research protocol for provider/prompt decisions

1. Read the official provider docs first: model ID, inputs, limits, result shape, moderation, price.
2. Read independent practitioner/help-center guidance on the exact failure (identity, hands, framing,
   moderation). Official capability claims are not quality proof.
3. Record the source URL and date. Separate `VERIFIED`, `SINGLE-SOURCE`, `TERTIARY` and `UNVERIFIED`.
4. If a source is inaccessible, say so and do not cite its assumed content. Search snippets are not full
   text.
5. Bound the research loop: answer a small set of concrete questions, then design a pilot. Do not keep
   searching for a prompt that promises perfection.
6. Prefer a measured local test over another vendor switch when the defect is structural (crop, aspect,
   mask, grade).

Useful official references from the pilot: [Runway character references](https://runway.com/resources/ai-character-references-tips),
[Runway consistent characters](https://runway.com/resources/create-consistent-ai-characters),
[Higgsfield two-character scene](https://higgsfield.ai/blog/two-characters-one-scene-ai-video),
[Higgsfield Soul ID](https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-create-and-use-a-soul-id-character),
[Luma master references](https://lumalabs.ai/learning-hub/using-master-reference-assets-in-luma-step-by-step-workflow),
[Recraft character consistency](https://www.recraft.ai/docs/best-practices/character-consistency),
[Hailuo subject stability](https://www.ai-hailuo.com/blog/hailuo-image-to-video/), and
[Rasgo full-body detail](https://www.rasgo.ai/blog/full-body-ai-images-face-detail). Re-open and re-date them
at use time; capabilities and prices change.

Reference implementation and verdicts: `METHODOLOGY-REVIEW.md` and `evidence/scratch/` in the Essence of
the Maasai project. Techniques shown to work there: full-frame garment repair, close-up anatomy repair,
uniform reframing with background-continuous padding, feature-shaped protection, and tip/hand close-ups.
Automatic skin segmentation, rectangular protection and registration-by-optimiser remain rejected.

## Step 5C: kie.ai production adapter

The current adapter is **capability-based**. Model availability, pricing and limits change, so open
the linked official docs at run time and record `verified_at`. Do not resurrect model IDs from an old
skill file without checking them.

Verified from official kie.ai documentation on **2026-10-27**:

| Desired outcome | kie.ai route | Important limit or finishing rule |
|---|---|---|
| Base still or storyboard review sheet | `gpt-image-2-text-to-image`, or the already-proven local `kie.mjs still` route (`seedream/5-pro-text-to-image`) | Keep real typography for the edit; a grid sheet is a review artifact, not truth |
| General brand/product motion | `bytedance/seedance-2` | Supports text, first-frame, first+last-frame and multimodal references; set `generate_audio:false` for silent assets |
| MiniMax H3-style motion | `minimax-h3/text-to-video`, with image/reference variants documented separately | Official docs say audio cannot be disabled; **strip audio for web use** |
| Controlled image-to-video | `kling-2.6/image-to-video` | Check sound and duration parameters; pilot with the actual reference |
| First/last-frame or native portrait generation | Veo 3.1 generation endpoint | Official docs list 16:9 and 9:16, reference modes and output upgrades; price generation and upgrades separately |
| Multimodal identity/reference guidance | `bytedance/seedance-2` | Docs list up to 9 images, 3 videos and 3 audio clips; do not combine mutually exclusive first/last-frame and reference fields |
| Human motion transfer | `kling-2.6/motion-control` | Requires a subject image plus a 3–30 s motion reference; unsuitable for precise UI animation |
| Voice, dubbing and lip-sync | Choose a documented KIE audio/avatar capability only after a runtime check and consent review | Keep narration as separate files so visuals can be reused; do not assume language or voice availability |
| Assembly, captions, logo lock, cutdowns | **Remotion/ffmpeg, not a video model** | Deterministic, legible and revisable; this replaces server-side assembly and Shorts Studio |
| Credits, upload and preview | KIE Common/File Upload APIs + local artifact review | Uploads expire after 24 hours; generated download links may expire after 20 minutes. Archive final assets locally |

Official references: [Seedance 2](https://docs.kie.ai/market/bytedance/seedance-2),
[MiniMax H3](https://docs.kie.ai/market/minimax-h3/text-to-video),
[GPT Image 2](https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image),
[Kling image-to-video](https://docs.kie.ai/market/kling/image-to-video),
[Kling motion control](https://docs.kie.ai/market/kling/motion-control),
[Veo 3.1](https://docs.kie.ai/veo3-api/generate-veo-3-video),
[File Upload API](https://docs.kie.ai/file-upload-api/quickstart), and
[Common API](https://docs.kie.ai/common-api/quickstart).

**These are documented capabilities, not a claim of equal output quality.** Before a batch, run the
same 1–3-shot pilot through the chosen adapter and compare identity, instruction following, text-free
cleanliness, motion, artefacts, cost and render time against the storyboard.

### Spend and failure protocol

1. Do the brief, facts, evidence map, script, storyboard and styleframes before paid generation.
2. Obtain explicit approval for the adapter and spend ceiling. Probe credit balance before the first
   paid job; estimate `representative unit cost × number of jobs` and include expected revisions.
3. Start with one representative still or short clip. Do not fan out a campaign before the pilot is
   accepted. Record balance before and after; keep the provider's job/error IDs.
4. Log every submitted job, including failures, in `PRODUCTION.md` and `LEDGER.md`: model, prompt or
   storyboard revision, inputs, job ID, credits, status, retry and artifact path.
5. Retry once unchanged for a transient failure. Next simplify the prompt/scene. Then use the planned
   simpler shot and continue. Do not strand a whole film on one stubborn generation.
6. Never invent a fixed price from an old table. Report actual measured spend. No "90% saved" or
   traditional-production comparison without a dated, sourced rate card.
7. Project spend before every submission: `actual + next estimated`. If it exceeds the approved ceiling,
   stop and request an explicit extension. A failed provider task may cost 0, but still record it.
8. Do not retry the same failing configuration. Classify the defect, change one variable, and require a
   new visual verdict. Repeated identical prompts are spend without learning.
9. Keep a **task/result JSON** for every job with model, input prompt, input URL/hash, task ID, state,
   actual credits, output path and operator review path. Log failures with their exact provider message.
10. Stop after a pilot passes. The next level gets a fresh go/no-go; a good still does not authorise motion,
    and a good minimal-motion clip does not authorise a complex action sequence or batch.

### Generated film pipeline — verified 2026-11-02 on a delivered 149 s music video

This is the whole production loop that turned a stills cut into an accepted film, in the order it has to
run. Everything here was paid for once and reviewed; the verdicts are in the project's
`evidence/scratch/` directory.

**A. Price the provider before you plan.** The published "from $X per second" is the *cheapest tier*, not
the tier you will order. Two probe jobs metered the real rate:

| Route | Resolution | Measured | Published "from" |
|---|---|---|---|
| `bytedance/seedance-2-mini` | 720p | **8.2 credits/second** | 2.4 |
| `bytedance/seedance-2-mini` | 480p | **3.8 credits/second** | — |

Rule: 720p is the floor for any shot carrying a face, hand or garment; 480p only for scenery, herds and
crowd wides. A 5 s character beat costs ~41 credits, a 5 s cutaway ~19. Put the measured rate in the
adapter's budget gate, not the quoted one, or every later decision is wrong by 3x.

**B. One beat per submission, with a table and a gate.** Keep a `BEATS` table in one script: id, model,
resolution, duration, reference images, review title, and a five-part prompt. The adapter refuses to
overwrite an archived clip, dry-runs by default, and asserts the budget before submission. Generate the
single most important beat **first** (the hero action), so a rejection there is affordable.

**C. Write the storyboard as a uniqueness contract.** A pool of beats rotated across many shots is what
produces "the same scene keeps repeating". Instead: an ordered shot list where each shot names its own
beat, and a machine check that fails the edit if any beat appears twice, if the timeline has a gap, or if
the total is not the track length:

```
make-edl-v2.py --check   →  31 shots, 31 unique sources, contiguous, 149.232 s   (problems: none)
```

If a beat is missing, generate that beat or cut the shot. Never fill the gap by reusing another scene.

**D. Read the reference before designing the motion.** When a supplied clip has no captions in any
language, sample it (≈25 frames across the runtime), read the frames, and send them to the image-capable
reviewer for a *grammar* reading: formation, who moves, the movement phases, camera height and lens,
light, and what makes it read as ceremony. That reading is what turns "dance scene" into a list of
filmable instructions.

**E. Detect onsets; do not cut on section energy.** Section-energy cuts produce a metrically regular grid
that feels unmusical — measured at a **median 180 ms** from the strong accents. Spectral flux over 16
log-spaced Goertzel bands (1024-sample frames, hop 256 at 22050 Hz), adaptive peak picking, then thinning
each onset against its own neighbourhood (so a sparse intro keeps long shots and a dense body cuts
tightly) lands every cut on a detected onset. Claim only what you can show: "every cut is a selected
onset" is provable; "the cuts hit the biggest hits" is not, and an independent broadband test will
probably contradict it.

**F. Prefer one continuous take for the hero action.** A 12 s uncut beat of one person jumping repeatedly
beats twelve separate clips: it cannot morph between shots, and it is the thing the audience remembers.
Constraints that matter: one body airborne at a time, camera locked (no follow, no zoom), whole body plus
headroom inside frame at every phase, and the crowd behind grounded.

**G. Repair framing deterministically, and verify the repair over time.** When a hero take loses the top
of a head at its apex, sky can be added without another generation — but three attempts failed visibly
before one worked, and the failures are the lesson:

| Attempt | Failure |
|---|---|
| per-column sample of the frame's top rows | grew a brown vertical stripe: the subject's braids were the brightest thing in the row |
| brightest sample across all frames | grew a pale band: a sunlit shoulder is brighter than that part of the sky |
| one static gradient for the whole clip | froze while the real sky brightened — measured as a **10.6–20.2 level step** at the seam |
| **per-frame sample of the outer thirds, built 64×16 and upscaled** | **seam step 1.4 levels; sky brightens with the frame** |

Rule: a deterministic repair that is invisible in one still can be a visible defect in time. Sample the
light per frame, keep the subject out of the sample region, and check the repaired band across the clip,
not on a single frame.

**H. Every beat gets an independent verdict before it is cut in.** In the final build the reviewer caught,
in this order: a wide night clip inserting a second, differently dressed jumper into the hero's beat; a
head-clipped second jump; a ten-shot loop of one clip from a broken pool rotation; a frozen sky seam; and
a wardrobe break at the jump apex. Each was a real defect that looked fine at a glance. Review with dense
frames, not a contact sheet alone, and record the verdict next to the artifact.

**I. Re-cutting and re-rendering are free — spend only on pixels.** The whole 149 s assembly is
deterministic (`make-edl-v2.py` → `build-film2.py`, frames streamed into ffmpeg, no intermediate PNG
pile). After the pixels are paid for, every edit decision, crop, retime and title change costs nothing,
so iterate on the cut rather than re-generating.

### Research protocol that actually paid off (2026-11-02)

Six research moves produced most of the session's savings. Each is cheap; each replaces a guess.

1. **Meter the provider instead of reading its price table.** Two probe jobs at the tier you will actually
   order cost ~56 credits and corrected a 3x planning error. The published "from $X/s" is the cheapest
   tier; read `actualCredits` from the ledger and put *that* in the budget gate.
2. **Read a caption-less reference by sampling frames.** `yt-dlp --list-subs` returns "no subtitles" →
   sample ~25 frames across the runtime at 1 frame per N seconds, read them in order, and write what the
   frames actually show. Two supplied links in this session had no captions at all; one description was
   channel boilerplate and the other was an unrelated brand blurb. Say plainly which reference was read
   and which was not — never describe a video you could not open.
3. **Send a reference to the image-capable reviewer for a *grammar* reading.** Asking for "formation,
   who moves, the movement phases, camera height and lens, light, and what makes it read as ceremony"
   returned a single sentence that reorganised the whole dance section, plus an explicit warning that the
   words "crowd"/"group of warriors" are what make models produce morphing clones.
4. **Search the vendor docs for the *model id and limit*, then the pricing page for the tier.** Do not
   resurrect an id from an old note; the ids change (`bytedance/seedance-2-5`, `bytedance/seedance-2-mini`
   were live while an older note still said `seedance-2` only).
5. **Bound the research loop.** Answer the concrete questions (id, inputs, price per second at this
   resolution, duration limits, reference-image count), then design the pilot. Two pages were enough; ten
   would not have changed the plan.
6. **Record every claim's evidence tag in the deliverable.** MEASURED / INFERRED / UNVERIFIED next to the
   number is what lets a later session — or a colleague's LLM — trust the file without re-deriving it.

### Mistakes made in this pipeline and the guard that now prevents each

Every row cost real money or real time. Keep them; they are cheaper to read than to repeat.

| Mistake | What it looked like | Guard |
|---|---|---|
| Delivered stills with slow zooms | 12 plates, 20 shots, "no movement" | a film must contain generated motion; a still-only cut is a slideshow, name it that way |
| Reused 16 beats across 72 shots | "the same scene keeps repeating, no story" | the uniqueness contract: one beat per shot, machine-checked |
| Cut to section energy | a metrically regular grid measured **180 ms** off the accents | spectral-flux onsets + local thinning; claim onset alignment only |
| Trusted the published price | planned 233 credits for work that cost 620 | meter the rate first; gate on the measured rate |
| Let an apex clip the head | head at y=0 for 26 frames of a 12 s take | measure the subject's top pixel on every airborne frame before accepting |
| Static deterministic repair | a frozen sky band with a **10.6–20.2 level** seam | sample the light per frame; verify the repair across time, not on a still |
| Wide night clip inserted a second jumper | bare-chested waist-wrap figure in the hero's beat | crowd beats are one airborne body and grounded ring, or they are not used |
| Broken pool rotation → 10 identical shots | the same jump ten times | round-robin per section, plus the uniqueness check |
| Infinite loop in a padding script | three tool calls killed, machine out of memory | bounded loops with a hard iteration cap and a test that fails loudly |
| Hard-coded private paths in a tracked doc | pre-publish scanner failure | keep literal machine paths in a git-ignored evidence file; ship placeholders |

## Step 5D: Optional Higgsfield upgrade path

Keep `BRIEF.md`, `FACTS.md`, `STORYBOARD.md`, the look kit, copy list and shot IDs unchanged. Replace
only the adapter. When the operator budgets for Higgsfield:

- map its image generation, video generation, reference inputs, voice/lip-sync and job preview to the
  same capabilities in the table above;
- use the same pilot and acceptance checks, not a different creative baseline;
- record what improved, what did not, render time and actual cost;
- do not emit inherited referral/share links or assume a connector exists because an old skill names
  it;
- retain the KIE/code route as a working fallback. There is no forced migration.

## Step 6: Assembly, packaging and repurposing

- Assemble visuals and narration independently. Reuse the same visuals when translating or revising a
  voice track; only the voice and captions should need replacement.
- Add logos, CTA locks, captions, charts and exact numbers in the deterministic edit layer.
- Produce vertical and square versions by recomposing camera, type and action. Verify each version,
  not just the master.
- For titles and thumbnails, make one honest focal point readable at phone size. A title may open a
  question the thumbnail does not answer, but the content must deliver it. No fake urgency or outcome.
- Turn a long master into shorts only where a complete hook-loop-payoff exists. Twenty automatically
  extracted clips are not twenty publishable clips.
- Campaign batches require a defined buyer, offer, channel and measurement plan. Do not inherit a
  fixed quota of videos, automatic Meta scheduling or a "virality predictor". Use actual retention and
  conversion feedback after publication to revise the next script.
- For client finding, split the offer by buyer (physical product, SaaS, productized local service).
  Use `outreach-planner`; never fabricate contact details, and follow the prospect's jurisdiction and
  the project's outreach rules.

## Step 7: Acceptance gates

Do not call a deliverable finished until all applicable gates pass.

### Meaning and truth

- A cold viewer can state what the offer is, who it is for, what happened on screen and what to do next.
- Every visual has an evidence job. At least one early surface demonstrates the offer rather than only
  setting a mood.
- Every claim traces to `FACTS.md`; every asset has a provenance label; demos and sample data are
  visibly labelled.
- The storyboard and final artifact agree shot by shot. Every planted narrative loop closes.

### Craft

- Fonts are loaded; text is crisp, legible and free of collisions or clipping in every aspect ratio.
- Product identity, palette and style survive across shots. No melted copy, accidental extra text,
  ghosting or flicker.
- Motion supports causality and reading. Important holds are actually readable. The CTA resolves and
  holds instead of trailing off.
- Audio, captions and visuals agree. Spoken content has captions/transcript; no unwanted generated
  soundtrack survives into a web background asset.

### Generated subject and motion

- **Stills:** one subject per recurring identity; native-resolution review of face, hands, feet, garment/
  product, labels, accessories, background, framing and provenance. Color channel spread >0; no fused
  digits, popped objects, rectangular crops, subject/background merge or invisible seam.
- **Masks/repairs:** zero differing pixels outside the intended mask is necessary; then prove the mask did
  not under-cover the subject and that protected features are bit-identical.
- **Motion:** review all frames or dense bursts. Assert identity across time, feet/ground contact,
  silhouette continuity, camera lock, background exposure, saturation, absent pop-ins and no frame-to-frame
  discontinuity. Contact-sheet-only acceptance is insufficient.
- **Temporal behavior:** a successful download and correct duration do not prove that exposure, light,
  identity or wardrobe stayed stable. Check every second and the 5–8 s region where drift commonly appears.
- **Grading/repair:** preserve RGB and subject pixels; reject a grade that fixes a number by changing
  identity, colour or anatomy. Verify the fix on the same probes and visually.
- **Rejected artifacts:** retained, named and verdict-linked. A passing new plate must not overwrite the
  evidence that explains earlier failures.

### Web and device

- Test desktop, portrait phone and reduced-motion states. Inspect intermediate states, not only the
  first and last frame. Check keyboard operation, pause/stop/hide where required, and contrast on the
  actual composited ground.
- Measure delivered bytes, duration, codec and frame rate. Check that the poster matches the first
  frame and that below-fold media does not load unnecessarily.
- Read a contact sheet or key stills with vision. A successful API response or a green layout test is
  not proof that the generated shot is good.
- **Say when a real phone has not been tested.** Headless Chrome cannot establish iOS autoplay,
  decoder, Low Power Mode or touch behavior.

### Economics and delivery

- The ledger reconciles to actual provider charges and includes failed jobs.
- Final files are archived locally; expiring upload/download URLs are not the only copy.
- The delivery note states what was generated, what is real versus demo, measured spend, verification
  evidence and exactly what remains untested.

## Required project files

```text
BRIEF.md             decisions, audience, CTA, channels, budget
FACTS.md             sourced claims and explicit unknowns
EVIDENCE-MAP.md      what each visual must explain or prove
STORYBOARD.md        authoritative shots, timing, copy and acceptance
SCRIPT.md/BLOCKS.md  required only for narrated work
LOOK-KIT.md          portable brand/style/reference contract
ADAPTERS.md          selected route, docs, verified_at and pilot results
METHODOLOGY-REVIEW.md research, failure classes, chosen production method
VISUAL-REVIEW.md     pinned visual objects and returned verdicts before refactors
ACCEPTANCE-*.md      explicit operator decisions on accepted/rejected layers and their limits
PRODUCTION.md        submitted jobs and artifact status
LEDGER.md            actual spend, including failures
DELIVERY.md          outputs, verification and unverified items
```

For generated-subject work also keep: a per-subject reference folder, rejected assets retained with their
verdicts, task/result JSON including the **input prompt**, and a review copy in the operator's configured
review directory. Never store credentials in any of these files.

## Website build lessons — read before building

Before planning or building a product/service website, read `website-build-lessons-itikia`. It is the
consolidated Itikia Section 1 post-mortem: 320px-first layout, never hiding the affordance or its
instruction, freezing the interaction contract and acceptance matrix, measuring the rendered DOM rather
than declared CSS, committing screenshot evidence with a manifest, and keeping visual approval separate
from real-device verification, deployment and market validation.

## Inherited practices to reject on sight

- Vendor/model `only` locks, hardcoded referral links, stale UUID/preset tables and hidden connector
  assumptions.
- Generated images presented as a website or real product UI; fake metrics, savings or client outcomes.
- Critical text generated inside video instead of set in the real type layer.
- "No captions" as a house rule, mandatory silence for every format, continuous motion everywhere,
  60 fps everywhere, or strobing as a style.
- Mass campaign generation before one pilot, automatic publishing, unsourced cost comparisons, and
  virality scores presented as evidence.

## Final response

Report the chosen route and why, the evidence structure, what was produced, actual spend, what was
visually and functionally verified, and what was not verified. Include the preview path/URL when a
page or render exists. Never claim equivalent quality between vendors without a same-storyboard pilot.
