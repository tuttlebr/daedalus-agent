# Daedalus Frontend Design Directive

**Version:** 2.0
**Date:** 2026-04-08
**Audience:** Engineering and UX team
**Status:** Living design document

**Companion documents:**

- [NVIDIA Branding Reference](./NVIDIA-branding-reference.md) — writing style, voice and tone, PACE framework, capitalization, punctuation, trademarks
- [Backend Reference](./SRD-backend-reference.md) — Redis data model, TypeScript types, deployment architecture, testing strategy, non-functional targets

---

## 1. Product Vision and Design Philosophy

Daedalus is a portable AI agent interface. It connects users to a multi-agent system with over 50 tools — web search, document retrieval, image generation and editing, code analysis, RSS feeds, Kubernetes operations, and more — from a phone, tablet, or desktop browser. It ships as a progressive web app that feels native on every platform.

### Design Thesis

The interface follows four principles:

1. **Dark-first glassmorphism.** Surfaces use frosted glass with backdrop blur and subtle white borders over a near-black background. Depth comes from blur intensity and surface opacity, not drop shadows or gradients. Light theme is supported but dark is the default and primary design target.

2. **NVIDIA Green is the hero.** The color `#76B900` is the singular brand accent. It marks active states, primary actions, success indicators, and focus rings. Every other color is neutral or semantic.

3. **Typography-driven hierarchy.** NVIDIA Sans carries the visual weight. Headings, body text, and labels create hierarchy through size and weight, not decoration. The interface is clean, minimal, and information-dense without feeling crowded.

4. **The agent is always alive.** The UI must always communicate what the agent is doing. During streaming, a heartbeat animation sweeps across the bottom of the chat. Tool calls appear as collapsible step cards in real time. The user never wonders "is it working?" — the answer is always visible.

### Cross-Device Parity

This is a single codebase delivered as a web app, an installable PWA on iOS and Android, and a desktop PWA. The mobile experience is not a shrunken desktop page. It has its own navigation pattern (bottom nav bar), its own input affordances (camera button, touch-optimized targets), and its own install flow. All devices share the same conversations, streaming state, and session data through Redis.

---

## 2. Information Architecture

### 2.1 Screen Inventory

| Screen | Route | Purpose |
| --- | --- | --- |
| Login | `/login` | Username/password authentication |
| Main Chat | `/` | Primary interface — where 95% of user time is spent |
| 404 | `/404` | Page not found |
| 500 | `/500` | Server error |
| Error Boundary | (any) | Unhandled React error recovery |

There is no multi-page routing. The Main Chat screen is a single-page application with modal overlays for Settings, Help, and Install Prompt.

### 2.2 Main Chat Layout Zones

```
┌──────────────────────────────────────────────────────────┐
│                    Browser / PWA Shell                     │
├────────────────┬─────────────────────────────────────────┤
│                │         Zone B: Chat Area                │
│  Zone A:       │  ┌─────────────────────────────────┐    │
│  Conversation  │  │  Chat Header (title)             │    │
│  Sidebar       │  ├─────────────────────────────────┤    │
│                │  │                                   │    │
│  - New Chat    │  │  Virtual Message List              │    │
│  - Search      │  │  (scrollable, auto-scroll)        │    │
│  - Folders     │  │                                   │    │
│  - Conv. List  │  │  [Agent Heartbeat during stream]  │    │
│  - Settings    │  ├─────────────────────────────────┤    │
│  - Export      │  │  Input Area                       │    │
│  - Help        │  │  (textarea + attach + send)       │    │
│  - Logout      │  └─────────────────────────────────┘    │
│                │                                          │
├────────────────┴──────────────────────────────────────────┤
│          Bottom Nav (mobile only, hidden on md+)          │
└───────────────────────────────────────────────────────────┘
```

**Zone A — Conversation Sidebar** (left, 200–500px resizable on desktop, full-screen overlay on mobile):
Contains the conversation list, folder structure, search, and action buttons. A drag handle between Zone A and Zone B allows desktop users to resize the sidebar. Width persists in session storage. The sidebar collapses via a toggle button or the keyboard shortcut Cmd/Ctrl+Shift+S.

**Zone B — Chat Area** (center, fills remaining width):
Contains the chat header with conversation title, a virtualized message list, the agent heartbeat indicator during streaming, and the input area anchored to the bottom. On empty conversations, a galaxy animation and the Daedalus logo fill the center. A QuickActions bar appears above the input with large attach and camera buttons.

**Zone C — Intermediate Steps Panel** (inline within messages, expandable):
Tool call details and agent reasoning steps appear as collapsible cards within assistant messages. When expanded, they show the full input/output of each tool call with syntax-highlighted JSON.

### 2.3 Navigation Model

**Desktop (768px and above):** Persistent sidebar alongside the chat area. The sidebar can be toggled open or closed.

**Mobile (below 768px):** The sidebar is hidden by default. A fixed bottom navigation bar provides three actions: Menu (toggles sidebar overlay), Attach (file picker), and New Chat. The sidebar slides in as a full-screen overlay with backdrop blur.

### 2.4 User Journeys

**First-time user:** Login → empty chat with galaxy animation → (optional) Install Prompt after a few seconds → type first message → see streaming response with agent heartbeat → conversation is auto-named from the exchange.

**Returning user:** Login → conversation list loads from Redis → select a previous conversation → continue chatting. The most recently active conversation is pre-selected.

**Cross-device user:** Using the app on a phone while a desktop session is open. Conversations update on both devices within two seconds via WebSocket and Redis pub/sub. If one device is receiving a streaming response, the other shows a streaming indicator on that conversation.

---

## 3. Design System

This section documents the actual design tokens implemented in `tailwind.config.js` and `styles/design-system.css`. For the full NVIDIA brand guidelines including writing style, see [NVIDIA Branding Reference](./NVIDIA-branding-reference.md).

### 3.1 Color Palette

**Brand colors:**

| Name | Hex | Role |
| --- | --- | --- |
| NVIDIA Green | `#76B900` | Primary accent, active states, focus rings, success |
| NVIDIA Green Dark | `#5A8A00` | Hover/pressed states |
| NVIDIA Green Light | `#91C438` | Highlights |
| Orange | `#EF9100` | Warning, network/timeout errors |
| Red | `#E52020` | Error, destructive actions |
| Blue | `#0074DF` | Info, rate limit indicators |
| Teal | `#1D8BA4` | Success semantic |

**Dark theme (default):**

| Surface | Value | Usage |
| --- | --- | --- |
| Background Primary | `#0A0A0A` | Page background |
| Background Secondary | `#121212` | Sidebar, secondary panels |
| Background Tertiary | `#1A1A1A` | Cards, elevated surfaces |
| Background Elevated | `#2A2A2A` | Dropdowns, tooltips |
| Text Primary | `#F5F5F5` | Body text, headings |
| Text Secondary | `#D4D4D4` | Secondary labels |
| Text Muted | `#A3A3A3` | Placeholder text, timestamps |
| Text Subtle | `#737373` | Disabled states |

**Light theme:**

| Surface | Value | Usage |
| --- | --- | --- |
| Background Primary | `#FFFFFF` | Page background |
| Background Secondary | `#FAFAFA` | Sidebar, panels |
| Background Tertiary | `#F5F5F5` | Cards |
| Text Primary | `#0A0A0A` | Body text |
| Text Secondary | `#666666` | Secondary labels |

**Chat-specific colors:**

| Element | Value |
| --- | --- |
| User message bubble | `rgba(118, 185, 0, 0.10)` — subtle green tint |
| Assistant message bubble (dark) | `rgba(17, 19, 24, 0.95)` |
| Assistant message bubble (light) | `rgba(245, 245, 245, 0.95)` |
| Input background | CSS variable `--chat-input-bg` |

### 3.2 Typography

**Font families:**
- **Primary:** NVIDIA Sans — loaded as individual weight files (300, 400, 500, 600, 700, 800) in WOFF2 format with `font-display: swap`. System fallback chain: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif.
- **Monospace:** JetBrains Mono for code blocks and inline code. Fallback: SF Mono, Monaco, Cascadia Code, Roboto Mono, Consolas, Courier New, monospace.

**Fluid type scale (CSS custom properties):**

| Token | Size | Usage |
| --- | --- | --- |
| `--font-size-xs` | clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem) | Badges, timestamps, labels |
| `--font-size-sm` | clamp(0.875rem, 0.8rem + 0.375vw, 1rem) | Secondary text, nav items |
| `--font-size-base` | clamp(1rem, 0.925rem + 0.375vw, 1.125rem) | Body text, messages |
| `--font-size-lg` | clamp(1.125rem, 1rem + 0.625vw, 1.25rem) | Section headings |
| `--font-size-xl` | clamp(1.25rem, 1.1rem + 0.75vw, 1.5rem) | Page titles |

### 3.3 Glassmorphism Surfaces

Glass effects are the primary depth mechanism. Each variant is a CSS class combining `backdrop-filter`, `background-color`, and `border`:

| Class | Blur | Saturate | Usage |
| --- | --- | --- | --- |
| `liquid-glass-nav` | 40px | 180% | Top navigation, sticky headers |
| `liquid-glass-control` | 24px | 160% | Buttons, controls, interactive elements |
| `liquid-glass-control-mobile` | 8px | — | Mobile-optimized controls (less GPU load) |
| `liquid-glass-overlay` | 64px | 180% | Modals, dialogs, full-screen overlays |
| `liquid-glass-accent` | 16px | 200% | Accent elements, highlighted controls |

**Glass surface colors:**
- Surface: `rgba(18, 18, 18, 0.72)`
- Hover: `rgba(24, 24, 24, 0.80)`
- Overlay: `rgba(12, 12, 12, 0.90)`
- Border subtle: `rgba(255, 255, 255, 0.06)`
- Border strong: `rgba(255, 255, 255, 0.12)`

### 3.4 Motion and Animation

**Duration conventions:**
- Micro-interactions (button press, toggle): 150ms
- Transitions (slide, fade): 200–300ms
- Decorative/ambient (heartbeat, galaxy): 1.5–3s

**Key animations:**

| Name | Duration | Behavior | Usage |
| --- | --- | --- | --- |
| `heartbeat-sweep` | 1.8s infinite | Gradient sweeps left to right with NVIDIA Green opacity peak. | Agent streaming indicator |
| `heartbeat-breathe` | 2s ease-in-out infinite | Dot scales 1→1.3 and glows, opacity 0.4→1 | Agent alive dot |
| `slideUp` | 0.3s | translateY(100%) → 0, opacity 0 → 1 | Toast entry, bottom sheet |
| `slideDown` | 0.3s | translateY(-100%) → 0, opacity 0 → 1 | Dropdown entry |
| `fadeIn` | 0.2s | opacity 0 → 1 | Overlay backdrop |
| `loadingBar` | 2s ease-in-out infinite | translateX sweep | Upload progress |

### 3.5 Iconography

**Library:** Tabler Icons (`@tabler/icons-react`), sizes 14–24px.

**Key icons by function:**

| Icon | Usage |
| --- | --- |
| `IconPaperclip` | Attach file |
| `IconCamera` | Camera / photo capture |
| `IconSend` | Send message |
| `IconSquare` | Stop streaming |
| `IconRefresh` | Regenerate response |
| `IconMenu2` | Mobile menu toggle |
| `IconPlus` | New chat |
| `IconWifi` / `IconWifiOff` | Online/offline status |

### 3.6 Breakpoints and Spatial Tokens

**Breakpoints:**

| Name | Width | Key layout changes |
| --- | --- | --- |
| xs | 475px | — |
| sm | 640px | — |
| md | 768px | Bottom nav hidden; sidebar becomes persistent option |
| lg | 1024px | Full desktop layout |
| xl | 1280px | Wide desktop |
| 2xl | 1536px | Ultra-wide |

**Touch targets (WCAG 2.1 AA):**
- Minimum: 44px (`--touch-target-min`)
- Comfortable: 48px (`--touch-target-comfortable`)
- Large: 56px (`--touch-target-large`)

**Safe area insets:** All layout edges respect `env(safe-area-inset-*)` for notched devices.

**Responsive spacing scale:** Space tokens scale with viewport — for example, `--space-4` maps to 16px on mobile and 24px on desktop.

### 3.7 Shadow System

| Token | Value | Usage |
| --- | --- | --- |
| `shadow-nvidia` | `0 0 5px rgba(0,0,0,0.3)` | Cards, subtle elevation |
| `shadow-nvidia-lg` | Layered multi-shadow | Prominent buttons, elevated cards |
| `shadow-nvidia-dropdown` | `0 6px 9px rgba(0,0,0,0.175)` | Menus, dropdowns |
| `shadow-glow-green` | `0 0 20px rgba(118,185,0,0.15)` | Primary CTAs |

---

## 4. Feature Areas

### 4.1 Chat Experience

**Empty state.** When no messages exist in the current conversation, the chat area shows a galaxy animation centered vertically with the Daedalus logo. The input bar sits at the bottom. Above the input, a QuickActions bar displays large, touch-friendly buttons for Attach and Camera. This is the invitation to start a conversation.

**Composed state.** Messages appear in a virtualized list. User messages are right-aligned with a subtle green-tinted bubble (`rgba(118, 185, 0, 0.10)`). Assistant messages are left-aligned, full-width, and render rich markdown content. Each message has a small avatar — user avatar on the right, agent avatar on the left. The list auto-scrolls to follow new content. If the user scrolls up during streaming, a "scroll to bottom" floating button appears.

**Streaming behavior.** When the agent is generating a response, the AgentHeartbeat component appears below the message list. It consists of three elements:

1. A **sweep bar** — a horizontal gradient that animates left to right in 1.8s cycles, using NVIDIA Green.
2. A **breathing dot** — a small circle that pulses (scale 1→1.3, opacity 0.4→1) on a 2s cycle, signaling the agent is alive.
3. **Activity text** — describes the current operation ("Searching the web...", "Generating image...", "Reasoning...") alongside an elapsed-time counter and small icons for completed step categories (brain for LLM calls, wrench for tool calls).

**Markdown rendering.** Assistant messages render GitHub Flavored Markdown including:
- Syntax-highlighted code blocks (lazy-loaded highlighter)
- Mermaid diagrams (lazy-loaded renderer)
- Chart.js visualizations (lazy-loaded)
- KaTeX math expressions (inline and block)
- Tables, blockquotes, lists, and horizontal rules
- Embedded images and video players
- Linked search results

**Conversation lifecycle.** The conversation is auto-named after the first user/assistant exchange. Users can rename it by clicking the title in the sidebar. The stop button (IconSquare) appears during streaming and cancels the response immediately. After a completed response, a regenerate button (IconRefresh) appears, which re-sends the last user message.

### 4.2 Agent Reasoning and Intermediate Steps

When the agent calls tools or performs multi-step reasoning, each step appears as a collapsible card within the assistant message. Steps are collapsed by default to keep the chat clean.

**Step card anatomy.** Each card shows:
- A category icon: brain (LLM call), wrench (tool call), or branch (workflow step)
- A friendly step name (for example "Web Search" rather than `serpapi_search_tool`)
- A brief context snippet
- Duration badge showing elapsed time, or a spinning loader if the step is still active

**Expand behavior.** Clicking a step card expands it to reveal the full input and output as syntax-highlighted JSON. The expansion is animated (slideDown, 0.3s).

**View modes.** Users can switch between:
- **Timeline view** (default): steps displayed in chronological order as a hierarchical tree
- **Category view**: steps grouped by type (LLM, Tool, Workflow)

**Controls.** The Settings dialog contains toggles for intermediate steps: enable/disable visibility, auto-expand on arrival, and duplicate step override. A search field in the steps area filters steps by keyword.

### 4.3 Multimodal Input

**Input bar anatomy.** The input area consists of:
- A textarea that auto-resizes with content (Shift+Enter for newlines, Enter to send)
- A paperclip button (IconPaperclip) to open the native file picker
- A camera button (IconCamera) to capture a photo from the device camera
- A send button (IconSend) that activates when text or attachments are present
- A stop button (IconSquare) that replaces send during active streaming

On empty conversations, the QuickActions bar above the input provides larger versions of the attach and camera buttons.

**File attachment flow:**
1. User clicks the paperclip button or drags files onto the chat area
2. Client-side validation runs against limits: images up to 75 MB (PNG, JPG, GIF, WebP, AVIF), documents up to 100 MB (PDF, DOCX, PPTX, HTML), video up to 75 MB (MP4, FLV, 3GP). Multi-select supports up to 15 images or 100 documents per batch. Video is single-file only.
3. A human-readable error appears if validation fails (for example "File exceeds the 75 MB image limit")
4. Accepted files upload to Redis with per-file progress bars (UploadProgressBar) and cancel buttons
5. Uploaded files appear as thumbnails (images) or badges (documents) below the textarea

**Paste from clipboard.** Cmd/Ctrl+V pastes images directly into the input as attachments.

**Drag and drop.** Dragging files over the chat area activates a visual drop indicator. Files dropped into the zone are validated and uploaded using the same flow.

**Camera capture.** Clicking the camera button opens the device camera. The captured photo is added as an image attachment.

**Collection selector.** When documents are attached, a CollectionSelector dropdown appears, letting the user choose which Milvus vector database collection to ingest into. The dropdown shows available collections, a loading state while fetching, an error state if the Milvus connection fails, and an option to create a new collection.

**Attachments in messages.** After sending, attachments render within the message:
- **Images:** OptimizedImage component with progressive loading — thumbnail first, full resolution on click. Images use lazy loading with IntersectionObserver.
- **Documents:** DocumentBadge showing filename, file type icon, and file size.
- **Video:** Inline player with play/pause controls and a poster frame extracted from the first frame.

### 4.4 Agent-Generated Images

When the agent generates or edits images, they appear inline within the assistant message as markdown images.

**Progressive loading.** Generated images load as thumbnails first (via `?thumbnail=true` query parameter). Clicking or tapping expands to the full resolution image.

**Image gallery.** When an assistant response contains two or more images, they render in a scrollable ImageGallery component. Clicking any image opens a lightbox overlay with navigation between images.

**Download.** Each generated image has a download button that saves the full-resolution image to the user's device.

**Image editing flow.** A user uploads an image, sends a message asking for modifications ("make it more vibrant", "remove the background"), and the agent returns an edited version. The original and edited images both appear in the conversation, allowing the user to compare results and iterate.

### 4.5 Conversation Management

**Sidebar anatomy (top to bottom):**
1. **New Chat button** — creates a fresh conversation and focuses the input
2. **Search bar** — real-time filter by conversation name as the user types
3. **Folder list** — expandable folders that group conversations. Folders support create, rename, and delete. Conversations can be organized into folders.
4. **Conversation list** — scrollable list sorted by `updatedAt`. Each item shows the conversation name and is highlighted when selected. Hovering reveals a trash icon for deletion. Clicking the name opens it; clicking the name of the active conversation allows renaming.
5. **Bottom actions** — Clear Conversations, Export Data, Settings, Help, user display name, Logout

**Export and import.** Export downloads all conversations as a JSON file. Import restores conversations from a JSON file, merging with existing data.

**Resizable sidebar.** On desktop, a drag handle between the sidebar and the chat area allows resizing between 200px and 500px. The width persists in session storage across page reloads.

**Mobile sidebar.** On screens below 768px, the sidebar is a full-width overlay that slides in from the left with backdrop blur. The chat header shows a hamburger icon (IconMenu2) that toggles the overlay. The bottom nav's Menu button also toggles it.

### 4.6 Cross-Device Sync

All conversation state lives in Redis. Any device with an authenticated session sees the same data.

**Real-time propagation.** When a user sends a message on Device A, Device B sees the conversation update within approximately two seconds. The sync pipeline works through Redis pub/sub: the API route writes to Redis, publishes an event on the user's channel, the WebSocket sidecar (or SSE stream) forwards it to all connected clients, and client hooks update local state.

**Streaming indicators.** When one device is receiving a streaming response, other devices show a streaming indicator on that conversation in the sidebar, so the user knows the agent is actively working.

**Session registry.** Each browser tab or device registers itself with a UUID-based session. Sessions send visibility-aware heartbeats. Stale sessions (missed heartbeats) are expired automatically. Tab close triggers cleanup via `sendBeacon`.

**Conflict resolution.** Last-write-wins based on `updatedAt` timestamp. If two devices edit the same conversation concurrently, the most recent write prevails.

### 4.7 Real-Time Streaming

**Token-by-token rendering.** As the backend generates a response, text appears incrementally in the message area. The virtual message list auto-scrolls to follow the growing content. Each token appends within the 16ms frame budget to maintain 60fps.

**Transport hierarchy:**
1. **WebSocket** (primary) — singleton `WebSocketManager` with ping/pong keep-alive every 30s
2. **SSE** (automatic fallback) — if WebSocket fails three consecutive times, the client switches to `EventSource`-based sync with identical callback signatures
3. **Polling** (last resort) — `/api/chat/async?jobId=` for job status when neither WS nor SSE is available

**Reconnection.** WebSocket reconnects with exponential backoff: base delay 1s, max 30s, 20% jitter. Battery-aware: below 20% battery, reconnect delays increase to 60s; below 10%, auto-reconnect stops entirely.

**Disconnection UX.** When connectivity is lost:
- An OfflineIndicator toast appears at the top center of the screen: red background, IconWifiOff, "No Internet Connection" text. It persists until connectivity returns.
- On reconnection, the toast transitions to green with IconWifi and "Back Online" text, then auto-hides after 3 seconds.
- If disconnected mid-stream, the partial response is preserved in IndexedDB. The client then polls the async job endpoint for the final result and reconciles.

### 4.8 Progressive Web App

**Install prompt.** After 2–3 seconds on first visit, the InstallPrompt component appears. The prompt is platform-specific:
- **Android / Desktop Chrome:** Shows a card with "Install Daedalus" messaging and an Install button that triggers the native `beforeinstallprompt` dialog.
- **iOS Safari:** Shows a modal with three-step instructions: tap Share → tap "Add to Home Screen" → tap Add. Includes illustrated icons for each step.

The prompt can be dismissed (7-day cooldown before re-showing) or permanently hidden (365-day block). It uses the `liquid-glass-overlay` style with an NVIDIA Green gradient icon.

**Offline behavior.** The service worker caches the app shell and static assets using an LRU cache manager with content-type-aware eviction. When offline:
- The app shell loads from cache
- Previously cached conversations are readable
- New messages queue in IndexedDB for background sync when connectivity returns
- The OfflineIndicator toast displays persistently

**Background processing.** When a long-running job is active:
- The BackgroundProcessingIndicator shows that work is in progress
- A Wake Lock keeps the screen active (with a 5-minute safety timeout)
- Battery detection reduces activity below 20% battery

**Push notifications.** When a long-running job completes while the app is backgrounded or the tab is hidden, a push notification fires to bring the user back.

**App manifest.** The PWA manifest declares:
- Display: standalone (native app appearance)
- Background color: `#000000`
- Theme color: `#76B900`
- Orientation: any (auto-rotate)
- Shortcut: "New Chat" accessible via long-press on the home screen icon

**Service worker updates.** When a new service worker version is detected, an UpdateToast prompts the user to reload. Accepting triggers `SKIP_WAITING` and reloads the page.

---

## 5. Mobile Experience

The mobile experience is not a responsive adaptation — it has its own navigation model, input patterns, and interaction design.

### 5.1 Bottom Navigation Bar

A fixed bottom bar appears on screens below 768px. It provides three actions:

| Button | Icon | Behavior |
| --- | --- | --- |
| Menu | `IconMenu2` | Toggles the sidebar overlay on/off |
| Attach | `IconPaperclip` | Opens the native file picker |
| New | `IconPlus` | Creates a new conversation |

**Visual treatment:** Frosted glass backdrop (`bg-black/60`, `backdrop-blur-xl`), top border of `border-white/[0.06]`. Active items display in NVIDIA Green with a pill-shaped indicator below. Buttons have a minimum width of 52px and height of 48px. Labels are compact at 9px.

**Touch feedback:** Active press scales to 90% (150ms ease-out transition). Safe area insets pad the bottom for notched devices and home indicators.

### 5.2 Mobile Sidebar

The sidebar opens as a full-screen overlay with backdrop blur, sliding in from the left. The chat header shows an IconMenu2 that toggles the overlay. The overlay can also be closed by tapping outside the sidebar area.

### 5.3 Keyboard Handling

Three hooks work together to handle iOS and Android virtual keyboards:
- `useIOSKeyboardFix` — prevents the input from sinking below the keyboard on iOS by applying CSS transforms during keyboard show/hide events
- `useVisualViewport` — tracks the visual viewport height (which excludes the keyboard area), ensuring the input area is always positioned above the keyboard
- `useKeyboardVisibility` — detects when the mobile keyboard appears or disappears, enabling layout adjustments

The net effect: the chat input always stays visible and accessible above the virtual keyboard on all platforms.

### 5.4 Touch Targets

All interactive elements meet WCAG 2.1 AA touch target requirements:
- Minimum size: 44 x 44px
- Comfortable size: 48 x 48px (used for primary actions)
- Large size: 56px (used for prominent CTAs)

### 5.5 Orientation and Responsive Behavior

The `useOrientation` hook detects portrait and landscape changes. Layout adjusts without content loss. The Help dialog renders as a bottom sheet on mobile and a centered modal on desktop.

---

## 6. Error States and Edge Cases

### 6.1 Error Recovery

The ErrorRecovery component automatically categorizes errors and displays appropriate UX:

| Category | Color | Icon | Retry Delay | Behavior |
| --- | --- | --- | --- | --- |
| Network | Amber | WiFi | 2s | Auto-retry with countdown timer |
| Timeout | Amber | Clock | 3s | Auto-retry with countdown timer |
| Server | Red | Server | 5s (30s for backend restart) | Auto-retry; special messaging for "backend unavailable" and "scheduler unreachable" |
| Rate Limit | Blue | Alert | 10s | Auto-retry with countdown timer |
| Authentication | Purple | Alert | — | Not recoverable; shows "Sign in" link |
| Validation | Red | Alert | 1s | Auto-retry with countdown timer |

Each error displays a human-readable message (not a technical error string). An expandable "Show details" section reveals the technical message for debugging. When an error occurs mid-stream and a partial response has been received, the partial content is displayed with an indication that the response was interrupted.

### 6.2 Offline Indicator

The OfflineIndicator is a fixed toast positioned at the top center of the screen, respecting safe area insets:
- **Offline state:** Red background, IconWifiOff, "No Internet Connection". Persists until connectivity returns.
- **Reconnected state:** Green background, IconWifi, "Back Online". Auto-hides after 3 seconds.

Uses frosted glass backdrop and `role="status"` with `aria-live="polite"` for screen reader announcements.

### 6.3 Memory Pressure

The MemoryWarning component monitors JavaScript heap usage on a 5-second interval:
- **Warning (70% heap used):** Automatically clears image blob caches to free memory. Shows a toast notification.
- **Critical (80% heap used):** Aggressively clears in escalating stages — image blobs, then intermediate steps older than 6 hours, then all caches, then session storage. Shows a notification for each level.

### 6.4 Streaming Interruption Recovery

If the connection drops during an active stream:
1. The partial response is persisted to IndexedDB by `useBackgroundProcessing`
2. The client switches to polling the async job endpoint (`/api/chat/async?jobId=`)
3. When the final result arrives, it reconciles with the partial response
4. The conversation is saved to Redis with the complete response

### 6.5 Empty States

| Context | Behavior |
| --- | --- |
| New conversation | Galaxy animation + Daedalus logo centered in the chat area |
| No conversations | Empty sidebar with New Chat button prominently visible |
| No search results | "No conversations found" message in the sidebar |
| No folders | Empty folder area (folders are optional) |

### 6.6 Error Pages

**404 — Page Not Found:** Centered Daedalus logo with a floating animation, "Page Not Found" heading, and a green "Go Home" link.

**500 — Server Error:** Same layout as 404 with "Server Error" heading.

**Error Boundary:** Catches unhandled React errors anywhere in the component tree. Displays "Something went wrong" with a "Reload page" button. In development mode, the error message is shown for debugging.

---

## 7. Onboarding and First-Run Experience

### 7.1 Login Screen

A centered layout with a galaxy background animation and the Daedalus logo. The form contains username and password fields with NVIDIA Green focus rings, a "Sign In" button (NVIDIA Green background), and an error alert area for invalid credentials (red with IconAlertCircle).

### 7.2 First-Run State

After login, the user lands on the Main Chat screen. On mobile, the sidebar is hidden; on desktop, it's visible but empty except for the "New Chat" button. The chat area shows the empty state (galaxy animation). The InstallPrompt appears after a 2–3 second delay on first visit.

### 7.3 In-App Help

The Help dialog is accessible from the sidebar's Help button. It contains 17 collapsible sections, each with an icon, title, and detailed content:

1. Chatting
2. Attaching Files
3. Taking Photos
4. Web Search and Browsing
5. Image Generation
6. Image Editing
7. Knowledge Bases
8. News and RSS Feeds
9. Meeting Notes from Transcripts
10. Document Q&A
11. Managing Conversations
12. Searching Conversations
13. Viewing AI Reasoning
14. Settings
15. Export and Import
16. Keyboard Shortcuts
17. Install as App (PWA)

The dialog uses the `liquid-glass-overlay` treatment. On mobile, it renders as a bottom sheet; on desktop, as a centered modal. It closes on Escape key or clicking outside.

### 7.4 Recommendations (Not Yet Implemented)

The following would improve the first-run experience:
- **Guided tour:** A step-by-step walkthrough highlighting the attach button, sidebar, and help button on first login.
- **Sample prompts:** Pre-populated prompt suggestions in the empty chat state (for example "Search the web for...", "Generate an image of...", "Summarize this document...") to help users discover capabilities.

---

## 8. Autonomous Agent

### 8.1 Concept

Daedalus supports an autonomous agent that runs on a schedule (Kubernetes CronJob). The agent logs in as a configured user, executes a predefined workflow (for example a daily research briefing), and writes the results into that user's conversation history.

### 8.2 Current UX

The autonomous agent's output appears as a regular conversation in the user's conversation list. It syncs through the same Redis and WebSocket pipeline as any other conversation. There is no visual distinction between agent-initiated and user-initiated conversations.

### 8.3 Recommendations (Not Yet Implemented)

- **Visual distinction:** Autonomous agent conversations should have a different avatar (for example a clock or calendar icon) and a header badge ("Daily Briefing") to differentiate them from user-initiated conversations.
- **Notification:** When a new briefing arrives, a badge or dot indicator should appear on the conversation in the sidebar.
- **Scheduling controls:** Future work could let users configure briefing topics, schedule, and whether they want the autonomous agent active — all from the frontend Settings panel.

---

## 9. Accessibility

**Target:** WCAG 2.1 AA compliance.

### Keyboard Navigation

- All interactive elements are reachable via Tab.
- Modals and overlays trap focus using the `useFocusTrap` hook. Pressing Escape closes any dialog or overlay.
- A skip-to-main link is available for keyboard users to bypass navigation.
- Keyboard shortcuts are documented in the Help dialog (Section 17).

### Screen Reader Support

- All icon buttons have descriptive `aria-label` attributes (for example the send button is labeled "Send message", not just "Send").
- The OfflineIndicator uses `role="status"` with `aria-live="polite"` to announce connectivity changes.
- Error recovery alerts use `role="alert"` for immediate screen reader announcement.
- Semantic HTML elements (`nav`, `main`, `aside`, `dialog`) structure the layout.

### Visual Accessibility

- **Color contrast:** Minimum 4.5:1 ratio for all text. Information is never conveyed by color alone — icons, text labels, or patterns always accompany color indicators.
- **Reduced motion:** All animations respect the `prefers-reduced-motion: reduce` media query. Users who prefer reduced motion see no sweep animation, no breathing dot, and simplified transitions.
- **High contrast:** The `prefers-contrast: high` media query is supported, increasing border visibility and reducing glass blur.
- **Focus indicators:** Consistent 2px NVIDIA Green ring with 2px offset (`focus-visible:ring-2 focus-visible:ring-nvidia-green/40`) on all focusable elements.
- **Font scaling:** Body text uses relative units (rem, clamp). The layout accommodates system font size preferences without breakage.

---

## 10. System Context

### 10.1 Architecture

```
┌──────────┐     ┌────────┐     ┌──────────────┐     ┌──────────────────────┐
│  Client  │────▶│ nginx  │────▶│ Next.js app  │────▶│ NAT backend service  │
│  (PWA)   │◀────│/Ingress│◀───│ API routes    │     │                      │
│          │     │        │     │ + WS sidecar  │     │                      │
│          │     │        │     └──────┬────────┘     └──────────┬───────────┘
│          │     │        │            │                          │
│          │     │        │      ┌─────▼─────┐              ┌────▼─────┐
│          │◀──── WebSocket / SSE │ Redis     │              │ External  │
│          │     updates + polling│ Stack     │              │ and in-   │
│          │                      │ job state, │              │ cluster   │
│          │                      │ sessions,  │              │ services  │
│          │                      │ pub/sub    │              └───────────┘
└──────────┘                      └────────────┘
```

**Primary chat path:**
1. Client posts to `/api/chat/async`
2. Frontend authenticates the user and stores job metadata in Redis
3. Frontend submits `/v1/workflow/async` to the backend
4. Frontend opens a parallel `/chat/stream` reader to capture tokens and intermediate steps
5. WebSocket and polling clients consume Redis-backed job status until finalization

### 10.2 Technology Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Framework | Next.js 14 (Pages Router) | Dev on port 5000; production behind nginx |
| UI | React 18, TypeScript, Tailwind CSS | Path alias `@/*` |
| State | React Context + Zustand | `home.context.tsx`, `home.state.tsx` |
| Realtime | WebSocket (primary), SSE + polling fallback | WS sidecar on :3001 |
| Data | Redis Stack (RedisJSON + Pub/Sub) | Sessions, conversations, attachments, jobs, sync |
| PWA | Service Worker, Web App Manifest | LRU cache, offline fallback, push notifications |
| Media | Sharp (server-side), client compression | Thumbnails, format detection |
| Testing | Vitest + coverage-v8 | Target >= 80% |

### 10.3 Backend Architecture

The frontend connects to a single NeMo Agent Toolkit backend. The UI accent is NVIDIA Green.

---

## 11. API Surface

### 11.1 REST Endpoints (Next.js API Routes)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat/async` | Submit chat message for async processing |
| GET | `/api/chat/async?jobId=` | Poll job status |
| GET | `/api/conversations` | List user's conversations |
| GET | `/api/conversations/{id}` | Get single conversation |
| POST | `/api/session/imageStorage` | Upload image to Redis |
| GET | `/api/session/imageStorage?imageId=` | Retrieve image (supports `?thumbnail=true`) |
| POST | `/api/session/videoStorage` | Upload video to Redis |
| POST | `/api/session/documentStorage` | Upload document to Redis |
| POST | `/api/session/registry` | Register session |
| PUT | `/api/session/registry` | Session heartbeat |
| DELETE | `/api/session/registry` | Unregister session |
| GET | `/api/sync/stream` | SSE stream (fallback) |
| POST | `/api/sync/notify` | Trigger sync event |
| GET | `/api/generated-image/{id}` | Serve agent-generated image from Redis |
| POST | `/api/document/process` | Extract text from uploaded document |
| GET | `/api/milvus/collections` | List available vector database collections |
| POST | `/api/push/subscribe` | Subscribe to push notifications |

### 11.2 WebSocket Messages

**Client → Server:**

| Type | Payload | Purpose |
| --- | --- | --- |
| `ping` | — | Keep-alive (every 30s) |
| `subscribe_job` | `{ jobId }` | Start receiving job status pushes |
| `unsubscribe_job` | `{ jobId }` | Stop receiving job status pushes |

**Server → Client:**

| Type | Payload | Purpose |
| --- | --- | --- |
| `pong` | `{ ts }` | Keep-alive response |
| `connected` | `{ userId, streamingStates }` | Initial connection with current streaming state |
| `conversation_updated` | `{ conversationId, conversation }` | Conversation data changed |
| `conversation_deleted` | `{ conversationId }` | Conversation removed |
| `conversation_list_changed` | — | Conversation list needs refresh |
| `streaming_started` | `{ conversationId, sessionId }` | Backend started generating |
| `streaming_ended` | `{ conversationId, sessionId }` | Backend finished generating |
| `job_status` | `{ jobId, status, ... }` | Async job progress update |
| `error` | `{ message }` | Server-side error |

---

## 12. Implementation Priorities

### Wave 1 — Foundation (Parallel)

| Work Item | Dependencies | Engineer Profile |
| --- | --- | --- |
| Chat experience polish (Section 4.1) | None | Frontend |
| Cross-device sync hardening (Section 4.6) | None | Full-stack |
| Performance baseline (Lighthouse, bundle analysis) | None | Frontend |

### Wave 2 — Streaming and Media (Parallel)

| Work Item | Dependencies | Engineer Profile |
| --- | --- | --- |
| WebSocket streaming, token-by-token (Section 4.7) | Wave 1 | Full-stack |
| Multimodal upload improvements (Section 4.3) | Wave 1 | Full-stack |
| Agent-generated image rendering (Section 4.4) | Wave 1 | Frontend |

### Wave 3 — PWA, Mobile, and Polish (Parallel)

| Work Item | Dependencies | Engineer Profile |
| --- | --- | --- |
| PWA offline and push notifications (Section 4.8) | Wave 2 | Frontend (PWA) |
| Mobile experience and bottom nav (Section 5) | Wave 1 | Frontend |
| Error states and recovery (Section 6) | Wave 2 | Frontend |
| Responsive design QA pass | Wave 1, Wave 2 | Frontend |

### Wave 4 — Hardening

| Work Item | Dependencies | Engineer Profile |
| --- | --- | --- |
| Accessibility audit (Section 9) | All | Frontend |
| Security audit | All | Security |
| Reliability testing (network interruption, Redis failure) | All | QA / Full-stack |
| Test coverage to >= 80% | All | All |

---

## Glossary

| Term | Definition |
| --- | --- |
| **NAT** | NeMo Agent Toolkit — the backend agent framework |
| **Backend** | The NeMo Agent Toolkit backend service, using NVIDIA Green as the UI accent |
| **Async Job** | A long-running chat request processed in the background with status tracking |
| **Streaming State** | A Redis-tracked flag indicating a conversation is currently receiving an agent response |
| **Session Registry** | System tracking which devices and tabs are active for a user |
| **Intermediate Step** | An agent's tool call or reasoning step, displayed as a collapsible card in the UI |
| **Glassmorphism** | The frosted glass visual effect achieved with `backdrop-filter: blur()` and semi-transparent backgrounds |
| **Liquid Glass** | The Daedalus-specific glassmorphism implementation, available as CSS utility classes (`liquid-glass-*`) |
| **Agent Heartbeat** | The animated sweep bar and breathing dot that indicate the agent is actively generating a response |
| **Bottom Nav** | The fixed mobile navigation bar (three buttons) that replaces the sidebar on screens below 768px |
| **QuickActions** | The large-button bar that appears above the input area on empty conversations |
