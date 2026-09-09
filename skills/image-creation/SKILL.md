---
name: image-creation
description: Create or edit requested photos, illustrations, logos, infographics, mockups, and visual assets using Daedalus's shared image brief and visual_media_tool. Image analysis alone does not need this skill.
---

# Image generation and editing

Translate the user's request into a precise visual brief, preserving their
medium, text, references, and explicit settings. This guidance is used both by
chat and by Create's prompt-preparation service; keep it self-contained.

## Application contract

In chat, call `visual_media_tool` with `operation=generate` or `edit`,
the original request in `prompt`, an `ImageBrief` in `brief`, and explicit
output choices in `options`. Use the registered schema. The application owns
provider selection, credentials, storage, and image references; do not call an
OpenAI SDK or use the shell as an alternate image backend.

Create prepares the same brief internally. When the user requests their prompt
exactly, use `guidance=exact`, preserve the literal prompt, and omit the brief.
Do not rewrite it or add a separate concept-selection step.

A brief accepts these fields:

| Fields                                    | Type and purpose                                               |
| ----------------------------------------- | -------------------------------------------------------------- |
| `scene`, `subject`, `medium`              | Strings describing what to depict                              |
| `composition`, `lighting`, `intended_use` | Strings describing framing, look, and use                      |
| `details`, `exact_text`                   | Lists of details and verbatim lettering                        |
| `changes`, `preserve`, `exclusions`       | Lists of requested changes, invariants, and exclusions         |
| `references`                              | One description per supplied image, in exact input order       |
| `options`                                 | Suggested output choices, subordinate to explicit user choices |

Supply only useful fields. References are descriptions, not image inputs or
proof that an image has been viewed. For edits, pass actual supplied
`imageRef` values or a supported `image_url`; keep the primary edit target
first. Preserve returned IDs and order. Do not invent references or substitute
a thumbnail for the full-resolution source.

## Prompt decisions

Name the requested medium. For photography, describe framing, light, textures,
and the desired level of retouching; use camera/lens cues for appearance rather
than claiming a physical simulation. For illustration, logos, or diagrams,
describe their own visual language instead of imposing photorealism.

Give concrete subject placement and negative space when layout matters. Put
exact lettering in `exact_text`, keeping spelling and punctuation intact.
Describe placement and typography separately. Add exclusions only when the user
requested them or they resolve a clear ambiguity; do not remove requested
logos/text or invent blanket stylistic restrictions.

For edits, specify what changes and what must remain. The latest request
overrides previous preservation rules: rebuild the preserve list when the
user changes composition, identity treatment, wording, or style. For multiple
inputs, explain each input's role and how they combine.

Use a clear initial brief and bounded corrections. Do not repeatedly generate
variations unless the requested deliverable or a visible defect warrants it.
Use [creative-ideation](../creative-ideation/SKILL.md) only when concept
exploration is actually requested.

## Template and trend steering examples

Treat a template or trending prompt as shorthand for a direction, not as a
hidden provider preset. Keep the user's words in `prompt`, then express the
desired identity treatment, era, composition, lighting, styling, texture, and
use as explicit brief values. Trend values are defaults only when the user
invokes that trend, and the latest request may replace any of them.

The Templates catalog below is a 2026-09-09 snapshot of the public
[ChatGPT Images](https://chatgpt.com/images) page. The Trending guidance covers
its rotating share-card feed and reusable product-curated values. These are
steering references, not requirements to reproduce the source examples. Do not
blend unrelated recipes. When a recipe needs a source image, use
`operation=edit`, put the primary `imageRef` first, describe its role in
`references`, and preserve identity or structure only to the extent the recipe
and user request require. Ask a recipe's follow-up question only when the user
has not already supplied the answer.

### Templates

Use the named recipe when the user invokes that template or clearly asks for
the same treatment:

- **Sketch:** Reimagine the supplied sketch as original finished artwork. Keep
  its subject, emotion, and gesture, but replace rather than trace its marks;
  enrich simple forms through a user-selected medium, material, color, texture,
  and lighting treatment.
- **Stickers:** Turn the supplied subject into nine distinct meme-reaction
  stickers in a square 3-by-3 sheet. Use exaggerated expressions, awkward poses,
  playful emoji cues, lo-fi cutout character, and wide fully transparent gaps;
  exclude a background, cast shadows, and overlap.
- **’80s flashback:** Preserve the person's recognizable identity, skin tone,
  and age while restyling hair, clothing, accessories, and surroundings for
  circa 1985. Use direct flash, faded color, soft analog grain, a red-orange date
  stamp, and no modern objects or lettering.
- **Create a caricature:** Exaggerate the person's recognizable features and
  depict their work through props and setting, using only conversation context
  the user actually supplied. Keep the result affectionate and readable rather
  than demeaning or cluttered.
- **Dorm redesign:** Preserve room geometry, viewpoint, openings, floor, and
  essential furniture while improving layout, storage, study ergonomics,
  lighting, wall treatment, comfort, and organization at believable scale. Ask
  about priorities and interests only when absent.
- **Anime:** Redraw the supplied subject with confident linework, restrained cel
  shading, saturated color, expressive proportions, and a playful warped
  environment. Keep the composition energetic, comedic, and intentionally
  non-photorealistic.
- **Underwater:** Make an extreme close underwater portrait just after entering
  a clear pool: calm expression, suspended hair or fabric, refracted light, and
  an ethereal weightless mood without signs of distress.
- **Pin collection:** Create eight cohesive hyperreal enamel-pin designs in a
  4-by-5 composition based on known interests. Include a portrait pin, a single
  descriptive-word pin, and a name pin; use bold flat color and infer nothing
  personal that the user has not provided.
- **Handwritten style:** Keep the photo visible and add sparse, rough,
  single-stroke white-pen overlays: selective outlines, arrows, dots, steam,
  sparkles, hearts, emoticons, and a short upbeat diary-like note with generous
  negative space.
- **Interior design:** Restyle the supplied room as photoreal mid-century modern
  design with clean lines, warm natural materials, sculptural furniture,
  coherent scale, bright natural light, and high-end editorial polish.
- **Disco mode:** Preserve the subject's silhouette and recognizable features
  while rebuilding its surface from beveled mirrored square tiles, chrome,
  silver, and glass. Use sparkles, subtle iridescence, glossy nightclub lighting,
  and a deep black background.
- **App design:** After obtaining the app name, purpose, and aesthetic, create a
  single 5.5-by-3 presentation mockup containing exactly one photo-free welcome
  screen, one home screen, and two product or service screens in one cohesive
  design system.
- **3D avatar:** Create one floating glossy vinyl designer-toy head per supplied
  person. Preserve identity while simplifying forms; add retro sunglasses,
  premium studio highlights, and a playful blue-sky-and-cloud backdrop.
- **Icon designs:** Produce a grid of 16–20 cohesive minimalist logo directions
  derived from the main subject through geometry, line, negative space, emblems,
  badges, and monograms on a light background.
- **Fix lighting:** Change lighting only. Preserve people, pose, expression,
  background, objects, crop, and composition exactly while correcting backlight,
  deep shadows, underexposure, or uneven illumination with soft, natural,
  flattering light and realistic skin texture.
- **Studio headshot:** Use the user's supplied prompt as the canonical example:
  “Transform this photo into an elevated fashion studio portrait. Choose a
  complementing-color background that enhances the subject's skin tone. Keep a
  tight head-and-shoulder composition with the subject centered and facing the
  camera straight with an optimistic expression. Apply directional lighting
  with subtle shadows. Preserve natural skin tones while making the image
  polished, minimal, and editorial—like a magazine photoshoot.” Map this to an
  edit that preserves identity and natural skin tone.
- **Chibi stickers:** Redraw the supplied person as a vertical chibi sticker
  pack on clean white, with a thick white cut line, varied cute expressions and
  activities, and very short reaction captions. Keep captions sparse enough to
  remain legible.
- **Cross-section:** Turn the main subject into a scientifically plausible
  educational cutaway on white. Use clean orthographic structure, believable
  internal layers, labeled callouts, inset details, and textbook or museum
  clarity instead of dramatic lighting.
- **Makeup guide:** Create a vertical, visual-first beauty-editorial analysis
  from the portrait. Preserve the person's real features and recognizability,
  show placement and color recommendations graphically, and use only short
  labels rather than paragraphs.
- **Enhance photos:** Improve clarity, exposure, color balance, noise, and useful
  detail while preserving the original subject, identity, content, crop, and
  photographic character; avoid cosmetic or structural changes.
- **Mini me:** Leave the source photo itself unchanged and add tiny animated 3D
  versions of its subject interacting naturally around them. Give the miniature
  figures a playful everyday story, believable depth and shadows, and at most a
  short sentimental title when text is wanted.
- **Wanderlust:** Place the main subject in a less-traveled destination as an
  instant-photo travel collage. Use destination-appropriate styling, intimate
  natural light, a clean memento layout, balanced souvenirs, and a handwritten
  postcard message in blue ink.
- **Scribble:** Deliberately redraw the subject like an awkward old mouse-made
  paint sketch on white: crude pixel-by-pixel marks, clumsy proportions, vague
  resemblance, and intentionally low production value.
- **Blueprint poster:** Reduce the main subject to white technical linework on a
  cobalt grid. Add orthographic contours, construction lines, measurements,
  arrows, minimal labels, and two or three inset views; exclude shading,
  realistic lighting, 3D rendering, and unrelated objects.
- **Color analysis:** Create a clean visual-first personal-color analysis from
  the portrait, using side-by-side clothing or drape comparisons, swatches, and
  short labels on a restrained neutral background.
- **Nighttime flash:** Restyle the photo as candid nightlife editorial imagery
  with harsh direct on-camera flash, bright highlights, deep shadows, a moody
  night background, imperfect framing, slight motion, glossy skin highlights,
  realistic color, and subtle grain.
- **Comic:** Redraw the supplied subject as a short Sunday-funnies sequence with
  thick outlines, halftone texture, bright 1980s color, clear panel flow, one
  exaggerated visual premise, minimal dialogue, and a legible punchline.
- **Anime comic:** Create an original black-and-white retro hand-inked manga in
  two or three horizontal panels. Keep the referenced character consistent,
  tell an uplifting setup-to-turnaround encounter with brief dialogue, and omit
  modern technology unless requested.
- **Fantasy newspaper:** Make the recognizable subject the central engraved
  portrait on a whimsical black-and-white vintage newspaper. Use high-contrast
  ink, subtle paper texture, classic serif display type, dense columns, and a
  few short magical or humorous headlines.
- **Bobblehead:** Turn the subject into an intentionally mass-produced plastic
  soccer bobblehead with an oversized head, tiny body, molded texture, generic
  country-inspired colors, ball, base, and a real stadium at early evening. Use
  loose facial inspiration and exclude teams, brands, premium resin, porcelain,
  anime styling, and pristine CGI character.
- **Infographic poster:** Recast the visible subject as a nineteenth-century
  botanical or scientific atlas plate: precise ink and crosshatching, idealized
  source colors on white, one main illustration, inset studies, guide lines,
  readable callouts, and concise anatomy-style notes.
- **Improve Your Desk Setup:** Audit the supplied desk in a clean editorial
  infographic comparing current and optimized arrangements. Annotate monitor,
  chair, light, cables, and clutter; group fixes as free, under $50, or
  investment; use symbolic ratings and a compact focus forecast, not paragraphs.
- **Film strip:** Convert the source into three sequential horizontal frames
  stacked vertically and full bleed. Show distinct moments with varied angles
  and distances, cool high contrast, deep blacks, grain, motion blur, candid
  emotion, and a clear visual progression.
- **Tarot card:** Depict the user as an original hand-drawn tarot figure with
  classic Rider-Waite visual grammar, bold imperfect black ink, flat color,
  paper-print texture, no modeled shading, and a small set of personally
  relevant symbols supported by available context.
- **Drawing:** Treat a childlike drawing or handmade image as the exact spatial
  blueprint, preserving its proportions, shapes, and charming quirks while
  rendering its materials, environment, depth, light, and shadows as a
  believable photograph.
- **Hyperreal wallpaper:** Create a vertical macro nature scene around one
  unexpected small subject, with tactile realism, very shallow depth of field,
  creamy bokeh, natural outdoor light, wabi-sabi imperfection, 35 mm grain,
  natural color, and soft contrast. Offer subject choices only when none exists.
- **8-bit game:** Turn supplied subjects and themes into one complete vertical
  side-scrolling game frame with detailed 16-bit pixel art, readable silhouettes,
  cohesive palette, classic HUD, humorous title, visible objective, and an
  uplifting nonviolent climax.
- **Football figurine:** After obtaining the name, field position, and country,
  create an original fictional soccer collectible in labeled sealed blister
  packaging. Use country-inspired but unbranded colors, generic accessories,
  two subtle cultural jokes, molded plastic and glossy packaging, a premium
  shelf-ready render, and no real teams, athletes, kits, or brand identities.
- **Landscape:** Create a cinematic ultra-real landscape with a softly blurred
  foreground, bokeh, layered depth, abundant negative space, 35 mm grain,
  natural color, and soft contrast; exclude people and structures. Offer a few
  numbered landscape choices only when the user has not chosen one.
- **Statue:** Recast the supplied subject as a photoreal neoclassical Carrara
  marble museum statue. For a person, preserve identity through an allegorical,
  confident pose and carved garments; for an object, do not add a person. Use
  warm dramatic museum light, natural perspective, and contextual artifacts.
- **Hairstyles:** Build a clean side-by-side hairstyle analysis from the
  portrait. Preserve the person's face, compare suitable cuts or styling
  directions visually, and use brief labels on a premium neutral background.

### Trending

Trending is a rotating feed, and its public cards may expose only **Add
yourself** rather than a stable template name. This rule covers every current or
future Trending card: use the card or shared post's actual title and prompt as
the theme, require the source image when its recipient action says it is
required, and convert the visible aesthetic into explicit brief values. Never
copy the featured person's identity, infer an unavailable prompt from a preview,
or claim a rotating card is still current without checking it. If the card
cannot be read and the user supplied no style description, ask for its share
link or screenshot.

Representative trend steering examples:

- **Neon 80s Portrait:** The shared
  [trend](https://chatgpt.com/s/p_659f135ed2ec8191a208f4f16a769813)
  requests a personal 1980s transformation. Use an identity-preserving edit with
  period hair and wardrobe, a tight portrait, warm facial key light, magenta and
  cyan rims, a dark neon environment, and subtle analog grain. A follow-up such
  as “believable yearbook, no neon” replaces those lighting and backdrop values.
- **Anime-style portrait:** Preserve the photographed person's identity cues
  while translating them into playful anime linework, cel shading, expressive
  features, and a coherent illustrated background.
- **Action figure portrait:** Use the person's photo as identity reference for
  an original boxed 3D hero toy; request a missing display name, and include a
  pet sidekick only when supplied or requested.
- **Cinematic raindrop portrait:** Create a high-contrast monochrome close
  portrait of the subject emerging from water, with droplets, wet texture,
  dramatic falloff, and a cinematic rather than hazardous mood.
- **Black-and-white studio portrait:** Use monochrome high-fashion portraiture,
  editorial framing, sculpted studio light, deep tonal separation, and realistic
  skin texture while preserving identity.
- **Puppet portrait:** Rebuild the supplied person as a handmade puppet with
  recognizable features, tactile fabric or foam, visible craft construction,
  and a staged practical set.

## Output choices

Use the current tool's `ImageOptions` contract:

- `quality`: Create supports `auto`, `low`, `medium`, `high`, `xhigh`, and
  `max`. Keep chat on `auto`; omit a chat quality suggestion because the
  application always delegates that choice to Sunburst. In Create, use
  `xhigh` or `max` only when it addresses an unmet quality requirement within
  the user's latency budget.
- `size`: `auto` or `WIDTHxHEIGHT`. GPT Image 2.5 Sunburst accepts edges
  divisible by 16, maximum edge 3840 inclusive, aspect ratio at most 3:1, and
  total pixels from 655,360 through 8,294,400. Examples: `1024x1024`,
  `1024x1536`, `1536x1024`, `3840x2160`.
- `n`: 1–8; default to one unless the user requests variants.
- `output_format`: `png`, `jpeg`, or `webp`.
- `background`: `auto`, `transparent`, or `opaque`. Transparency
  requires PNG/WebP. Preserve alpha through follow-up edits.
- `output_compression`: 0–100 for JPEG/WebP; omit for PNG.

Honor explicit output choices over recommendations. Do not pass `model` or
`input_fidelity` as per-call options. The application fixes the provider model
to GPT Image 2.5 Sunburst and omits the legacy fidelity field.

## Verification and delivery

Inspect the returned image when an image-viewing/analysis tool is available.
Check requested content, exact lettering, edit invariants, composition, and
transparency. Do not assert those checks passed from the prompt alone.

Return the exact generated-image Markdown reference from `visual_media_tool`
so the frontend can render it. An error or failed persistence is not a
delivered image. Do not fabricate `/api/generated-image/` URLs.

For analysis-only requests, use `operation=analyze` directly.
[Daily-summary](../daily-summary/SKILL.md) uses source-only images and never
invokes generation/editing; do not replace missing reporting images with art.

Prompt craft follows the
[OpenAI GPT Image 2.5 prompting guide](https://developers.openai.com/api/docs/guides/image-prompting).
The local shared brief and option validation govern Daedalus calls.
