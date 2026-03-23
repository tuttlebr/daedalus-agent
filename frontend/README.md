# Daedalus Frontend

Next.js 14 chat interface for the Daedalus AI assistant.

## Development

```bash
npm install           # Install dependencies
npm run dev           # Start dev server on port 5000
npm run build         # Build for production
npm run test          # Run tests (Vitest, watch mode)
npm run coverage      # Generate test coverage report
npm run lint          # Run Next.js linter
npm run format        # Format with Prettier
```

## Project Structure

```
pages/
  api/
    chat.ts              # Main chat endpoint (SSE streaming)
    chat/async.ts        # Background job processing for PWA
    auth/                # Login, logout, session management
    conversations/       # Conversation CRUD
    session/             # Redis session state
    milvus/              # Vector DB collection management
    sync/                # Cross-device real-time sync
    document/            # Document ingestion
    usage/               # Usage analytics
  api/home/
    home.tsx             # Main application page
    home.context.tsx     # Global state context
    home.state.tsx       # State reducer

components/
  Chat/
    ChatInput.tsx        # Message input with file attachments
    ChatMessage.tsx      # Message rendering (markdown, images, code)
    QuickActions.tsx     # Attach file, camera, Deep Thinker toggle
    CollectionSelector.tsx  # Vector DB collection picker
    IntermediateSteps/   # AI reasoning visualization
  Chatbar/               # Sidebar with conversations and settings
  Help/
    HelpDialog.tsx       # In-app user guide
  Settings/
    SettingDialog.tsx     # User preferences
  Sidebar/               # Sidebar layout and buttons
  Markdown/              # Markdown + LaTeX + code rendering
  Auth/                  # Login page and auth provider
  PWA/                   # Install prompt, offline indicator

services/
  sse.ts                 # Server-sent events streaming

hooks/
  useRealtimeSync.ts     # Cross-device sync via SSE

utils/
  app/                   # Conversation, storage, import/export helpers
  sync/                  # Real-time sync utilities
```

## Key Features

- **Dual AI modes**: Standard (fast) and Deep Thinker (comprehensive research)
- **File attachments**: Images, documents, and videos with inline display
- **Streaming responses**: Real-time SSE from backend agents
- **Intermediate steps**: Visualize AI reasoning with timeline/category views
- **Conversation management**: Folders, search, rename, export/import
- **Cross-device sync**: Real-time updates via Redis pub/sub and SSE
- **PWA support**: Installable app with background processing and offline access
- **In-app help**: Built-in user guide accessible from the sidebar
