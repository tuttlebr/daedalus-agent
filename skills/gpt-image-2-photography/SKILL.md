---
name: gpt-image-2-photography
description: Generate high quality photos and images with the OpenAI GPT Image 2 (gpt-image-2) endpoint. Use when a user asks to create, generate, or edit an image, photo, logo, infographic, mockup, or visual asset via the OpenAI Images API. Distilled from the official OpenAI prompting guide (developers.openai.com cookbook, April 2026).
---

# GPT Image 2 — High Quality Photo & Image Generation

Source of truth: OpenAI Cookbook "GPT Image Generation Models Prompting Guide"
(https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)

## 1. Model and Parameters

Use `gpt-image-2` as the default model. It has the best quality, editing
reliability, and flexible sizing. Legacy models (`gpt-image-1.5`,
`gpt-image-1`) are for backward compatibility only. Use `gpt-image-1-mini`
only when cost and throughput dominate, for large batches of drafts.

API entry points:

- `client.images.generate(model="gpt-image-2", prompt=..., ...)` for text to image.
- `client.images.edit(model="gpt-image-2", image=[file1, file2, ...], prompt=..., ...)` for image plus text to image.

Key parameters:

| Parameter            | Values                                       | Guidance                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`              | `gpt-image-2`                                | Default for all new work                                                                                                                                                                                                       |
| `quality`            | `low`, `medium`, `high`                      | Start with `low` for latency-sensitive or high-volume work. Use `medium` for most assets. Use `high` for small or dense text, detailed infographics, close-up portraits, identity-sensitive edits, and high-resolution outputs |
| `size`               | Any resolution meeting the constraints below | Default `1024x1024` square, `1024x1536` portrait, `1536x1024` landscape                                                                                                                                                        |
| `background`         | `transparent` (preview)                      | Requires `output_format="png"` or `"webp"`. `jpeg` does not support transparency                                                                                                                                               |
| `output_format`      | `png` (default), `webp`, `jpeg`              | Keep PNG or WebP when transparency matters                                                                                                                                                                                     |
| `output_compression` | optional                                     | Omit for PNG. WebP supports optional compression                                                                                                                                                                               |
| `n`                  | number of variations                         | Use for logo and concept exploration (for example `n=4`)                                                                                                                                                                       |
| `input_fidelity`     | `low`, `high`                                | `gpt-image-2` output is high fidelity by default. Set `input_fidelity="high"` on edits when identity preservation matters                                                                                                      |

### Size constraints for `gpt-image-2`

Any resolution is valid when ALL of these hold:

- Max edge length is less than `3840px`
- Both edges are a multiple of `16`
- Long edge to short edge ratio is at most `3:1`
- Total pixels are between `655,360` and `8,294,400`

Treat anything above `2560x1440` (2K) as experimental; results get more
variable. Reference sizes: `1024x1024`, `1024x1536`, `1536x1024`,
`2560x1440`, `3824x2144` (round 4K down to a valid size).

## 2. Prompt Structure

Write prompts in this consistent order:

1. **Background / scene**
2. **Subject**
3. **Key details** (materials, texture, lighting, composition)
4. **Constraints** (what to exclude, what to preserve)
5. **Intended use** when relevant (ad, UI mockup, infographic, slide) to set the polish level

Rules:

- Use the format easiest to maintain. Descriptive paragraphs, JSON-like
  structures, and labeled segments all work. For production, prefer a
  skimmable template over clever syntax.
- Use short labeled segments or line breaks for complex requests, not one
  long paragraph.
- Be concrete about materials, shapes, textures, and the visual medium
  (photo, watercolor, 3D render).
- Add quality levers only when needed: "film grain", "textured
  brushstrokes", "macro detail".
- State exclusions and invariants explicitly: "no watermark", "no extra
  text", "no logos/trademarks", "preserve identity/geometry/layout".
- Iterate instead of overloading. Start with a clean base prompt, then
  refine with small single-change follow-ups ("make lighting warmer",
  "remove the extra tree"). Repeat the preserve list on every edit to
  reduce drift.

## 3. Photorealism (the core photography recipe)

To get believable photos, prompt as if a real photo is being captured in
the moment. Include the word **"photorealistic"** directly in the prompt;
it strongly engages photorealistic mode. Similar cues: "real photograph",
"taken on a real camera", "professional photography", "iPhone photo".

Do NOT rely on detailed camera specs for physical simulation. Use them for
high-level look and composition only; they may be interpreted loosely.

Recipe:

1. Say "photorealistic" and name the photographic medium (for example,
   "35mm film photograph").
2. Describe real texture and imperfection: "pores, wrinkles, fabric wear",
   "no glamorization, no heavy retouching".
3. Specify framing and viewpoint: close-up, wide, top-down, medium
   close-up at eye level.
4. Specify lighting and mood: soft diffuse, golden hour, high-contrast,
   shallow depth of field, natural color balance, subtle film grain.
5. Avoid studio-polish language when you want a candid feel.
6. For wide, cinematic, low-light, rain, or neon scenes, add extra detail
   about scale, atmosphere, and color so the model does not trade mood for
   surface realism.

Example skeleton:

```
Create a photorealistic candid photograph of [subject] in [scene].
[Real texture details: skin texture, worn materials, everyday detail.]
Shot like a 35mm film photograph, [framing] at [angle], using a 50mm lens.
[Lighting: soft coastal daylight, shallow depth of field, subtle film grain, natural color balance.]
The image should feel honest and unposed. No glamorization, no heavy retouching.
```

## 4. Composition, People, and Action

- Specify framing (close-up, wide, top-down), perspective/angle (eye-level,
  low-angle), and lighting/mood (soft diffuse, golden hour, high-contrast).
- If layout matters, call out placement: "logo top-right", "subject
  centered with negative space on left".
- For people, describe scale, body framing, gaze, and object interactions:
  "full body visible, feet included", "child-sized relative to the table",
  "looking down at the open book, not at the camera", "hands naturally
  gripping the handlebars". These details fix body proportion, action
  geometry, and gaze alignment.

## 5. Text In Images

- Put literal text in **quotes** or **ALL CAPS**.
- Spell tricky words (brand names, uncommon spellings) letter-by-letter.
- Specify typography: font style, size, color, placement, kerning.
- Demand verbatim rendering: "EXACT, verbatim, no extra characters", text
  "appears once and is perfectly legible".
- Use `quality="medium"` or `"high"` for small text, dense panels, and
  multi-font layouts.

## 6. Transparent Backgrounds (preview)

To generate or edit with a transparent background:

1. Set `background="transparent"`.
2. Set `output_format="png"` (default) or `"webp"`. Never `jpeg`.
3. Omit `output_compression` for PNG.
4. Describe the subject as "isolated on a fully transparent background"
   and exclude "scenery, solid backdrop, checkerboard, or unwanted
   shadows".
5. On edits, repeat "preserve the transparent background" in every prompt
   so later steps do not introduce an opaque scene.
6. Save the output with a matching `.png` or `.webp` extension and never
   convert RGBA to RGB; that discards the alpha channel.

## 7. Editing Workflows (text + image -> image)

Multi-image inputs:

- Reference each input by index and description: "Image 1: product photo... Image 2: style reference...".
- Describe how they interact: "apply Image 2's style to Image 1", "put the bird from Image 1 on the elephant in Image 2".
- For compositing, state what moves where, and what must remain unchanged.
- Match lighting, perspective, scale, and shadows so the composite looks
  naturally captured.

Editing patterns:

- **Surgical edits**: "change only X" + "keep everything else the same".
  Also block changes to saturation, contrast, layout, arrows, labels,
  camera angle, and surrounding objects. Example: "In this room photo,
  replace ONLY [X]. Preserve camera angle, room lighting, floor shadows,
  and surrounding objects."
- **Identity preservation** (try-on, person in scene): "Do not change her
  face, facial features, skin tone, body shape, pose, or identity in any
  way. Preserve her exact likeness, expression, hairstyle, and
  proportions." Set `input_fidelity="high"`.
- **Style transfer**: keep the reference's visual language (palette,
  texture, brushwork, film grain) while changing the subject. Add hard
  constraints on background, framing, and "no extra elements".
- **Sketch to render**: "Preserve the exact layout, proportions, and
  perspective. Choose realistic materials and lighting consistent with the
  sketch intent. Do not add new elements or text."
- **Weather/lighting transformation**: change only environmental
  conditions (light, shadows, atmosphere, precipitation, ground wetness);
  preserve identity, geometry, camera angle, and object placement.
- **Translation**: "Translate the text in the image to [language]. Do not
  change any other aspect of the image." Keep typography, placement,
  spacing, and hierarchy; translate verbatim.
- **Character consistency** (multi-image): create a reusable character
  anchor image first, then feed it into `images.edit` with "Same [outfit,
  facial features, proportions, color palette]" and "Do not redesign the
  character".

## 8. Task-Specific Recipes

- **Infographics / diagrams**: define the audience and lesson objective.
  Use `quality="high"` for dense layouts. Ask for clean flat visual
  systems, consistent icon style, clear arrows, readable labels, white
  space. List required components explicitly and state what to exclude.
- **Slides and charts**: write the prompt like an artifact spec. Name the
  deliverable, canvas, and hierarchy. Provide real numbers and labels in
  the prompt. Landscape size for decks. Exclude clip art, stock photos,
  gradients, and generic treatment.
- **Logos**: describe brand personality and use case; ask for "clean,
  original mark with strong shape, balanced negative space", flat design,
  readable at small sizes. Generate with `background="transparent"`,
  `output_format="png"`, and `n=4` variations.
- **Ads**: write like a creative brief (brand, audience, culture, concept,
  composition, exact quoted tagline). Ask for the tagline rendered exactly
  once, "no extra text, no watermarks, no unrelated logos".
- **UI mockups**: describe the product as if it already exists. Focus on
  layout, hierarchy, spacing, and real interface elements. Avoid concept
  art language.
- **Comics / story beats**: one clear visual beat per panel, concrete and
  action-focused.
- **World knowledge**: the model infers context (for example, Bethel NY in
  August 1969 implies Woodstock). Give place and date; ask for period-
  accurate clothing, staging, and environment.

## 9. Quality Checklist Before Calling the API

- [ ] Prompt ordered: scene -> subject -> details -> constraints -> use
- [ ] "Photorealistic" (or the target medium) named explicitly
- [ ] Framing, angle, and lighting specified
- [ ] Texture and imperfection described for candid photos
- [ ] Exclusions stated (no watermark, no extra text, no logos)
- [ ] Invariants stated for edits (change only X, keep everything else)
- [ ] In-image text quoted verbatim with typography constraints
- [ ] Quality setting matches text density and fidelity needs
- [ ] Size fits the gpt-image-2 constraints; above 2K flagged as experimental
- [ ] Transparency paired with PNG/WebP, alpha channel preserved end to end
