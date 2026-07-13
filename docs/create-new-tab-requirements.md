# Create New Tab Requirements

Date: 2026-06-17
Status: Draft for implementation
Owner: Frontend

## 1. Purpose

Create New is the dedicated image playground in Daedalus. It lets users create
new images and modify existing images with OpenAI GPT Image 2 in a focused,
fast, and iterative workspace.

The experience should feel like a production-grade creative tool rather than a
chat side feature. Desktop users should get a broad canvas with persistent
controls. Mobile users should get the same core power through touch-safe
controls, bottom sheets, and a persistent prompt dock that respects safe areas.

## 2. Source References

Use the official OpenAI documentation as the source of truth for model and API
behavior:

- Image generation guide:
  https://developers.openai.com/api/docs/guides/image-generation
- Create image API reference:
  https://developers.openai.com/api/reference/resources/images/methods/generate/
- Edit image API reference:
  https://developers.openai.com/api/reference/resources/images/methods/edit/
- GPT Image 2 model page:
  https://developers.openai.com/api/docs/models/gpt-image-2

Implementation must re-check these pages before changing capability tables,
request schemas, or model defaults because image model capabilities can change.

## 3. Goals

- Provide a first-class playground for text-to-image generation and image
  editing with GPT Image 2.
- Make iteration fast: generate, compare, inspect, reuse, edit, download, and
  restore history without leaving Create New.
- Keep desktop and mobile feature-complete, with layout patterns optimized for
  each form factor.
- Preserve security boundaries by routing all OpenAI/backend calls through
  authenticated server routes.
- Make failures clear and recoverable without losing prompt, settings, or
  attached assets.

## 4. Non-Goals

- Do not build a full raster painting editor in v1.
- Do not move Create New to a conversational Responses API workflow in v1.
- Do not expose OpenAI credentials or backend-only image payloads to the
  browser.
- Do not replace the existing chat image flow.
- Do not add social sharing, team galleries, billing controls, or marketplace
  features in v1.

## 5. Users And Primary Jobs

- Creative operator: needs quick prompt exploration, multiple variants, and
  downloadable outputs.
- Product or marketing user: needs controlled edits, product shots, logos,
  banners, and format choices.
- Mobile user: needs to create or revise an image from a phone without losing
  access to settings, history, or output actions.
- Agent user: needs to send an output back to chat when the surrounding app
  enables that handoff.

Primary jobs:

- Generate one or more images from a prompt.
- Edit one or more input images using a prompt.
- Preserve selected visual details during an edit.
- Use masks for localized edits.
- Reuse a generated output as the next edit input.
- Restore previous runs from history.
- Download or open outputs.
- Clear history without accidentally deleting image assets, or deliberately
  clear both when the user chooses to reclaim their generated assets.

## 6. Information Architecture

Create New remains a top-level app view alongside Chat and Autonomy.

Required entry points:

- Desktop: keep the existing top view tab labeled `Create New`.
- Mobile: add a primary bottom-nav item labeled `Create`, using the sparkles
  icon. Tapping it sets `activeView` to `create`.
- Output handoff: when a host supplies `onSendToChat`, expose `Send to chat`
  actions on generated outputs.

The mobile `Create` nav item must not conflict with `New`, which creates a new
chat conversation. Use distinct labels, icons, and active states.

## 7. Core Workflows

### 7.1 Generate

1. User opens Create New.
2. User selects `Generate`.
3. User enters a prompt or applies a preset and edits the resulting prompt.
4. User optionally changes settings.
5. User submits.
6. The canvas shows loading cells for the expected output count.
7. Results appear as partials when available, then as final outputs.
8. User can select, inspect, download, open, remove, send to chat, or reuse an
   output as edit input.
9. The run is stored in history.

### 7.2 Edit

1. User selects `Edit` or chooses `Use as input` on an output.
2. User attaches one or more input images.
3. User optionally attaches a mask for Image 1.
4. User enters an edit prompt.
5. User optionally fills the preserve list.
6. User submits.
7. The backend receives image refs, mask ref if present, prompt, model, session,
   user, and cleaned GPT Image 2 parameters.
8. Outputs render in the same canvas and are stored in history.

### 7.3 Restore From History

1. User opens History.
2. User selects a run.
3. The app restores mode, model, prompt, params, input images, mask, outputs,
   and selected output.
4. User can rerun, modify, or continue editing from the restored state.

## 8. Functional Requirements

### 8.1 Modes

- CN-FR-001: The view must expose two explicit modes: `Generate` and `Edit`.
- CN-FR-002: Switching modes must not clear prompt text, generated outputs, or
  history.
- CN-FR-003: Adding an input image or reusing an output as input must switch the
  mode to `Edit`.
- CN-FR-004: Submit is disabled when the prompt is blank.
- CN-FR-005: Submit is disabled in `Edit` mode when no input images are
  attached.

### 8.2 Prompt Dock

- CN-FR-010: The prompt dock must remain visible at the bottom of the Create
  New workspace on desktop and mobile.
- CN-FR-011: The prompt field must auto-grow up to 30 percent of viewport
  height, then scroll internally.
- CN-FR-012: `Ctrl+Enter` and `Cmd+Enter` must submit when the form is valid.
- CN-FR-013: Placeholder text must reflect the active mode.
- CN-FR-014: The dock must include controls for presets, settings, edit assets
  when in Edit mode, current settings summary on non-small viewports, and
  submit.

### 8.3 Settings

- CN-FR-020: Settings must include model, output count, quality, size, output
  format, background, moderation, and compression when relevant.
- CN-FR-021: The only model in v1 is `gpt-image-2`, labeled `GPT Image 2`.
- CN-FR-022: Output count choices are 1, 2, 4, and 8.
- CN-FR-023: Size must support `auto`, curated common sizes, and custom
  `WIDTHxHEIGHT` values.
- CN-FR-024: Custom sizes must be validated before submit.
- CN-FR-025: Compression must appear only for JPEG and WebP.
- CN-FR-026: Unsupported params must be removed before sending requests.
- CN-FR-027: Desktop settings must be visible in a persistent right sidebar.
- CN-FR-028: Mobile settings must open as a bottom sheet.

### 8.4 Presets

- CN-FR-030: Presets must be filtered by mode.
- CN-FR-031: Applying a preset must seed the prompt and settings without
  submitting automatically.
- CN-FR-032: Edit presets may also populate preserve-list text.
- CN-FR-033: Presets must be cleaned against GPT Image 2 capabilities before
  applying settings.

### 8.5 Input Images

- CN-FR-040: Edit mode must support up to 16 input images.
- CN-FR-041: Input thumbnails must show stable numeric labels: Image 1, Image 2,
  and so on.
- CN-FR-042: Users must be able to remove individual inputs and clear all
  inputs.
- CN-FR-043: The UI must instruct users to reference attached images by number
  in the prompt.
- CN-FR-044: Upload errors must not remove already-attached images.
- CN-FR-045: Input metadata should include width, height, MIME type, and alpha
  presence when the browser can determine them.

### 8.6 Masks

- CN-FR-050: Edit mode must support one optional mask for Image 1.
- CN-FR-051: The mask must be a PNG with transparent pixels.
- CN-FR-052: When Image 1 dimensions are known, the mask dimensions must match
  Image 1.
- CN-FR-053: The UI must show a mask thumbnail and an overlay preview when a
  mask is attached.
- CN-FR-054: Users must be able to remove the mask without clearing input
  images.
- CN-FR-055: Mask validation failures must be shown inline near the mask
  control.

### 8.7 Canvas And Outputs

- CN-FR-060: The output canvas must fill remaining space above the prompt dock.
- CN-FR-061: The grid must use 2 columns on mobile, 3 on tablet, and 4 on
  desktop unless a future responsive design explicitly changes these breakpoints.
- CN-FR-062: Loading cells must show status, index, output count, and elapsed
  seconds.
- CN-FR-063: Partial image events must render temporary outputs when the backend
  streams them.
- CN-FR-064: Final outputs must replace partial outputs.
- CN-FR-065: Selecting an output must make it available in the desktop detail
  panel.
- CN-FR-066: Output actions must include reuse as input, download, open full
  size, remove, and send to chat when available.
- CN-FR-067: Mobile output actions must be directly tappable; no action may
  rely on hover-only visibility.

### 8.8 Output Detail

- CN-FR-070: Desktop must show an output detail panel for the selected output.
- CN-FR-071: Output detail must include preview, prompt, model, params, and all
  output actions.
- CN-FR-072: When no output is selected, the panel must show a concise empty
  state.
- CN-FR-073: Mobile may omit the persistent detail panel, but must still expose
  every output action from the canvas or an action sheet.

### 8.9 History

- CN-FR-080: History must persist up to 50 entries per authenticated user or
  session according to existing session storage rules.
- CN-FR-081: A history entry must include mode, prompt, params, input images,
  mask image, output image IDs, model, created timestamp, and usage when
  available.
- CN-FR-082: Users must be able to restore an entry, delete one entry, and clear
  all entries.
- CN-FR-083: Delete and clear operations must optimistically update UI and
  reconcile from the server on failure.
- CN-FR-084: The history drawer must close with Escape and backdrop click.
- CN-FR-085: Mobile history must use a full-width drawer or sheet that does not
  conflict with the prompt dock.
- CN-FR-086: Clearing history must make the default retention behavior clear;
  deleting generated assets requires a separate, deliberate confirmation.
- CN-FR-087: A requested download must return the original Redis-backed image
  as an attachment with a useful filename, without loading the full asset into
  browser JavaScript first.

## 9. Responsive UX Requirements

### 9.1 Desktop

- CN-UX-001: Desktop layout uses header, canvas, prompt dock, and persistent
  right sidebar.
- CN-UX-002: The right sidebar width should remain near 360 px unless product
  design changes the global layout.
- CN-UX-003: The canvas must preserve stable grid dimensions while loading and
  after results arrive.
- CN-UX-004: Hover affordances may supplement desktop actions but must not be
  the only way to access them.

### 9.2 Mobile

- CN-UX-010: Create New must be reachable from mobile bottom navigation.
- CN-UX-011: The header, mode switcher, history control, canvas, asset panel,
  sheets, and prompt dock must fit without overlap on 375 px wide screens.
- CN-UX-012: Touch targets must be at least 44 x 44 px for primary actions.
- CN-UX-013: Bottom sheets must respect viewport height and `safe-area-inset`
  spacing.
- CN-UX-014: The virtual keyboard must not permanently hide submit or settings
  controls.
- CN-UX-015: All destructive actions must be deliberate and recoverable where
  practical.

## 10. API And Data Requirements

### 10.1 Browser To Frontend API

- CN-API-001: Browser submissions must go to `POST /api/images/jobs` rather
  than keeping the browser-to-proxy connection open for the full OpenAI call.
  The legacy `/api/images/generate` and `/api/images/edit` proxies remain
  compatible for non-panel callers.
- CN-API-002: Requests must include `prompt`, `model`, and cleaned image params.
- CN-API-003: Edit requests must include `imageRefs`; they may include
  `maskRef`.
- CN-API-004: Requests must not include raw OpenAI credentials.
- CN-API-005: `POST /api/images/jobs` returns HTTP 202 with a `jobId`.
  `GET /api/images/jobs?jobId=...` returns Redis-backed job status; the UI
  polls it and may restore active jobs after a reload or mobile reconnect.
- CN-API-006: The job runner persists streamed partial/final events and history
  metadata in Redis, so a transient browser connection does not discard a
  completed result.

Expected generate request shape:

```json
{
  "prompt": "A studio product photograph of ...",
  "model": "gpt-image-2",
  "n": 4,
  "quality": "high",
  "size": "1024x1024",
  "output_format": "png",
  "background": "opaque",
  "moderation": "auto"
}
```

Expected edit request shape:

```json
{
  "prompt": "Change only the label color. Keep the bottle shape.",
  "model": "gpt-image-2",
  "quality": "high",
  "imageRefs": [
    {
      "imageId": "stored-image-id",
      "sessionId": "session-id",
      "mimeType": "image/png"
    }
  ],
  "maskRef": {
    "imageId": "stored-mask-id",
    "sessionId": "session-id",
    "mimeType": "image/png"
  }
}
```

Expected response shape:

```json
{
  "imageIds": ["generated-image-id"],
  "model": "gpt-image-2",
  "prompt": "Final prompt text",
  "usage": {}
}
```

Expected job-acceptance response:

```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

### 10.2 Frontend API To Backend

- CN-API-010: Frontend API routes must require an authenticated user.
- CN-API-011: Frontend API routes must add `sessionId`, `user`,
  `x-session-id`, and `x-user-id`.
- CN-API-012: Frontend API routes must clean params with the shared image model
  capability helper before proxying.
- CN-API-013: Frontend API routes must use the backend paths
  `/v1/images/generate` and `/v1/images/edit`.
- CN-API-014: Frontend API routes must use a long enough timeout for image
  generation and edits; the current target is 300 seconds.
- CN-API-015: Timeout responses must map to HTTP 504.
- CN-API-016: Backend unavailable responses must map to HTTP 502.
- CN-API-017: Helm nginx configuration must give `/api/images/` a timeout that
  exceeds the backend image timeout and must disable response/request buffering
  for streaming-compatible routes.

## 11. Validation And Error Requirements

- CN-ERR-001: Blank prompt error: `Prompt is required`.
- CN-ERR-002: Edit without input error: `Add at least one input image or switch
to Generate.`
- CN-ERR-003: Invalid custom size errors must explain the exact constraint.
- CN-ERR-004: Invalid mask errors must explain PNG, transparency, or dimension
  mismatch.
- CN-ERR-005: Backend timeout must be shown as a recoverable service error.
- CN-ERR-006: Backend unavailable must be shown as a recoverable service error.
- CN-ERR-007: Moderation or model refusal errors from the backend must preserve
  the original message where safe.
- CN-ERR-008: Errors must not clear prompt, settings, inputs, mask, outputs, or
  history.
- CN-ERR-009: A transient job-status polling failure must be retried before the
  UI treats an in-flight image job as failed.

## 12. Accessibility Requirements

- CN-A11Y-001: Mode switcher must use radio semantics.
- CN-A11Y-002: History must use dialog semantics and close with Escape.
- CN-A11Y-003: Popovers and mobile sheets must expose dialog semantics.
- CN-A11Y-004: All icon-only buttons must have accurate `aria-label` text.
- CN-A11Y-005: Generated output tiles must be keyboard-selectable.
- CN-A11Y-006: Focus outlines must be visible on dark backgrounds.
- CN-A11Y-007: Reduced-motion users should not be blocked by loading or sheet
  animations.

## 13. Security And Privacy Requirements

- CN-SEC-001: Image history writes must verify generated image ownership before
  accepting output IDs.
- CN-SEC-002: Stored input images and generated images must follow existing
  Redis session/user ownership rules.
- CN-SEC-003: Raw uploaded image content must be stored through existing image
  storage endpoints, not embedded in history.
- CN-SEC-004: Downloads and full-size opens must use existing authenticated or
  scoped image-serving routes.
- CN-SEC-005: No secrets may be added to frontend code, fixtures, or docs.

## 14. Observability And Performance Requirements

- CN-OPS-001: The UI must track generation status as idle, queued, submitting,
  generating, or finalizing.
- CN-OPS-002: The UI must show elapsed seconds during generation.
- CN-OPS-003: Image thumbnails should use existing optimized image paths.
- CN-OPS-004: Prompt keystrokes should not force expensive canvas/sidebar
  rerenders.
- CN-OPS-005: History fetches should use existing query caching and invalidate
  after mutations.
- CN-OPS-006: Large image uploads should surface progress or an uploading state.

## 15. Acceptance Criteria

Desktop:

- AC-001: A user can generate 4 images, inspect the selected output, download
  it, and reuse it as an edit input without leaving Create New.
- AC-002: A user can edit an uploaded image with a mask, see validation errors
  for invalid masks, and submit successfully with a valid mask.
- AC-003: A user can restore a prior run from history and rerun it with changed
  params.

Mobile:

- AC-010: A user can reach Create New from bottom nav.
- AC-011: A user can open settings as a bottom sheet, change size/quality, and
  generate an image.
- AC-012: A user can attach edit images from a bottom sheet and submit an edit.
- AC-013: Output actions are tappable without hover.
- AC-014: The prompt dock, bottom nav, and bottom sheets do not overlap on a
  375 px wide viewport.

Failure handling:

- AC-020: Invalid prompts, missing edit inputs, invalid masks, invalid sizes,
  backend timeouts, and backend unavailable states show recoverable errors.
- AC-021: Failed submits leave user-entered prompt/settings/assets intact.

## 16. Test Plan

Unit tests:

- Validate GPT Image 2 capability cleaning.
- Validate custom size constraints.
- Validate output format and compression interactions.
- Validate presets by mode and capability-cleaned preset params.
- Validate history restore behavior.

Component tests:

- Generate submit payload uses `/api/images/generate`.
- Edit submit payload uses `/api/images/edit` with `imageRefs` and optional
  `maskRef`.
- Submit disabled states match prompt and edit-input requirements.
- Partial image events render temporary outputs and final response replaces
  them.
- Desktop output detail exposes all required actions.
- Mobile settings/assets/history open as sheets or drawers.
- Mobile output actions are visible/tappable.

API route tests:

- `POST /api/images/generate` requires auth, cleans params, forwards user and
  session headers, and maps timeout/unavailable errors.
- `POST /api/images/edit` requires auth, cleans params, forwards refs, and maps
  timeout/unavailable errors.
- `GET/POST/DELETE /api/images/history` preserves ownership validation and
  50-entry history limit.

Manual verification:

- Run `npm run lint`.
- Run `npm test -- --run`.
- Run `npm run build`.
- Check desktop width, tablet width, and 375 px mobile width.
- Verify no visible text overlap, no unreachable controls, and no hover-only
  required actions.

## 17. Implementation Notes

- Existing relevant modules include `components/images/*`,
  `state/imagePanelStore.ts`, `utils/app/imageModelCapabilities.ts`,
  `utils/app/imagePresets.ts`, `pages/api/images/generate.ts`,
  `pages/api/images/edit.ts`, and `pages/api/images/history.ts`.
- Prefer extending existing image panel patterns instead of adding a parallel
  image playground.
- Keep UI state in the existing Zustand store unless a new state boundary is
  justified by measurable complexity.
- Keep backend API shape stable for the current frontend routes.
- Use existing Popover bottom-sheet behavior for mobile settings and assets.
- Add mobile nav support in `components/mobile/BottomNav.tsx` when implementing
  the mobile entry requirement.

## 18. Open Decisions

Resolved for v1:

- Scope: implementation-ready requirements.
- API model: direct Image API through existing generate/edit proxy routes.
- Mobile prominence: primary bottom-nav item.

Future decisions:

- Whether to add a Responses API powered conversational editing mode after v1.
- Whether to add in-browser mask painting instead of upload-only masks.
- Whether to add durable project galleries beyond the current 50-entry history.
