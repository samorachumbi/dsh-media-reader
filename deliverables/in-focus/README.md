# IN FOCUS

## Original 48-second video-generation concept

**Status:** Generation package only; no video has been rendered in this environment.

This is an original reinterpretation based on broad visual motifs observed in four sampled frames: monochrome studio photography, an unbranded white sports car, close-up hand and jewelry details, and stark title cards. It does not reuse the source video's artist identity, lyrics, audio, logos, or title text.

## Format

- **Runtime:** 48 seconds, assembled from eight 6-second clips
- **Frame:** 16:9, 1920×1080, 24 fps
- **Look:** Photorealistic, high-contrast black and white, controlled studio lighting, subtle film grain
- **Accent color:** Muted crimson, used only for editorial title graphics
- **Editing:** Hard cuts on the beat; no generated morph transitions
- **Audio:** Original 84 BPM half-time hip-hop instrumental, deep sub-bass, dry rim clicks, sparse metallic percussion, no copied melody or lyrics

## Continuity anchors

Reuse these descriptions verbatim in every relevant generation request. If the tool supports character or object references, create clean reference stills before generating motion.

### Performer A

A fictional adult lead performer with close-cropped hair and a trimmed beard. Studio wardrobe: plain charcoal crew-neck shirt, black wide-leg trousers, simple steel watch. Portrait wardrobe: ivory utility jacket with black piping, angular dark glasses, one geometric pendant, one ring, and one beaded bracelet. No real-person likeness.

### Performer B

A fictional adult dancer with long hair, wearing a structured sleeveless obsidian outfit and dark boots. Movement is controlled, minimal, and sculptural rather than acrobatic.

### Vehicle

An unbranded white two-door electric concept coupe with smooth bodywork, flush door handles, a black panoramic roof, and geometric black wheels. The vehicle's shape, wheel design, and proportions must remain unchanged in every shot.

### Set

A seamless pale-gray studio cyclorama with a reflective dark floor, soft overhead light grid, deep controlled shadows, and no visible crew or equipment.

## Global generation prompt

> Photorealistic luxury music-video cinematography in high-contrast black and white. Fictional adult performers, unbranded white electric concept coupe, seamless pale-gray studio cyclorama, reflective dark floor, controlled overhead lighting, sculptural composition, restrained performance, realistic anatomy, natural fabric motion, consistent faces and wardrobe, subtle 35mm grain, crisp detail, 24 fps, cinematic 16:9 frame. The camera movement is slow and physically plausible.

## Global negative prompt

> real-person likeness, celebrity likeness, brand logo, manufacturer badge, watermark, caption, subtitle, generated lettering, extra fingers, malformed hands, face drift, changing identity, changing wardrobe, warped jewelry, flicker, exposure pumping, warped wheels, changing vehicle geometry, floating objects, clipping through the car, fast camera shake, cartoon, anime, plastic skin, oversharpening, low resolution

## Shot-by-shot generation plan

### Clip 01 — 00:00–00:06 — Signal

**Visual prompt:**

> A nearly black frame. A single thin horizontal white light slowly opens across the center, revealing faint film grain and a narrow crimson editorial line beneath it. Minimal, precise, symmetrical composition. No people, vehicle, logo, or text. The light movement is smooth and slow.

**Editorial overlay:** Add in post, not in the generator:

- Small tracked text: `A STUDY IN CONTRAST`
- Large condensed title: `IN FOCUS`

**Optional original voiceover:** “Perfection is not louder. It is clearer.”

**Transition:** Hard cut on the first downbeat.

### Clip 02 — 00:06–00:12 — The reveal

**Visual prompt:**

> Low, hood-height wide shot of the unbranded white concept coupe in the seamless gray studio. Performer A stands at frame left in the charcoal studio wardrobe, facing camera. Performer B sits motionless on a separate matte-black cube at frame right. The car spans the lower half of the frame. Soft overhead lights turn on in sequence, creating deep shadows and clean highlights. Static camera, restrained poses, realistic anatomy.

**Transition:** Hard cut.

### Clip 03 — 00:12–00:18 — Presence

**Visual prompt:**

> Slow lateral dolly from left to right at hood height. Performer A, in the charcoal studio wardrobe, stands beside the front quarter of the white concept coupe and addresses the camera with one calm hand gesture. Performer B remains a distant sculptural figure in the background. The vehicle stays rigid and geometrically consistent. High-contrast monochrome, shallow but readable depth, no lip-sync requirement.

**Transition:** Hard cut on a percussion hit.

### Clip 04 — 00:18–00:24 — Detail portrait

**Visual prompt:**

> Tight frontal portrait of Performer A in the ivory utility jacket with black piping, angular dark glasses, one geometric pendant, one ring, and one beaded bracelet, against a pure black background. The performer slowly raises an open palm toward the lens until the hand occupies the left foreground while the face remains partially visible. Harsh directional key light, deep blacks, realistic fingers and jewelry, shallow depth of field, very slow push-in.

**Transition:** Match cut from the palm to a bright car-surface reflection.

### Clip 05 — 00:24–00:30 — Machine detail

**Visual prompt:**

> Extreme close-up of the white concept coupe's front fender and geometric black wheel. A narrow overhead softbox reflection travels smoothly across the paint as the camera makes a short, slow slider move. Performer A appears only as a soft reflection passing across the bodywork. No badges or lettering. The wheel remains stationary and perfectly round.

**Transition:** Hard cut to overhead view.

### Clip 06 — 00:30–00:36 — Geometry

**Visual prompt:**

> Directly overhead locked-off shot. The white concept coupe forms a clean diagonal across the dark reflective studio floor. Performer A and Performer B move slowly into two balanced positions on opposite sides of the vehicle, creating a symmetrical graphic composition. No dancing acrobatics, no interaction with the vehicle, no camera rotation. Monochrome, precise shadows, realistic movement.

**Transition:** Hard cut as both performers stop moving.

### Clip 07 — 00:36–00:42 — Statement

**Visual prompt:**

> Centered low-angle hero shot. Performer A stands directly in front of the white concept coupe, wearing the charcoal studio wardrobe, with Performer B positioned farther back and off-center. The camera pushes in very slowly while the performer holds a calm, direct gaze. Overhead lights narrow into a single pool of light around the pair and vehicle. Strong symmetry, stable faces, no text or logos.

**Transition:** Cut to black for two frames, then into the final wide shot.

### Clip 08 — 00:42–00:48 — Resolution

**Visual prompt:**

> Static extreme-wide shot of the empty studio with only the unbranded white concept coupe centered in the distance. Overhead light banks switch off one by one from the edges toward the center until only a thin rim light outlines the vehicle, then the image fades to pure black. No people, text, or logos. Slow, controlled, physically plausible lighting change.

**Editorial overlay:** After the frame reaches black, add in post:

- `IN FOCUS`
- `AN ORIGINAL VISUAL STUDY`

**Audio ending:** Final bass note cuts cleanly at 00:47, leaving one second of room tone.

## Recommended generation workflow

1. Generate approved reference stills for Performer A, Performer B, the vehicle, and the studio.
2. Use the same character and vehicle references for every applicable clip.
3. Generate each shot independently at 6 seconds; avoid asking one model run to produce the entire sequence.
4. Keep all typography out of the video model and add titles in an editor for exact spelling.
5. Reject clips with identity drift, malformed hands, changing wheels, or vehicle warping rather than trying to hide them with faster cuts.
6. Assemble with hard cuts at 6-second boundaries, apply one shared monochrome grade, and add only original or properly licensed audio.

The accompanying `prompts.json` contains the same plan in a machine-readable structure.
