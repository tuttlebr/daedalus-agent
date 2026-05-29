# Repository Guidelines

## Project Structure & Module Organization

This is a Next.js 14 TypeScript frontend for Daedalus. Route pages and API handlers live in `pages/`, with backend-facing API routes under `pages/api/`. Reusable UI is organized by domain in `components/` (`chat`, `autonomy`, `images`, `primitives`, etc.). Shared hooks live in `hooks/`, Zustand stores in `state/`, app utilities in `utils/app/`, server-only helpers in `server/`, and websocket client code in `services/`. Static assets, PWA files, icons, and locales are in `public/`. Tests are centralized in `__tests__/` and mirror the source area.

## Build, Test, and Development Commands

Use Node.js 22 and install with:

```bash
npm ci --legacy-peer-deps
```

- `npm run dev`: starts local Next.js development on port `5000`.
- `npm run build`: builds production output and injects the precache manifest.
- `npm run start`: serves the built app on port `5000`.
- `npm run lint`: runs Next.js ESLint checks.
- `npm test -- --run`: runs Vitest once; `npm test` starts watch mode.
- `npm run coverage`: runs Vitest with V8 coverage reports.
- `npm run format`: formats the repository with Prettier.

## Coding Style & Naming Conventions

Write TypeScript and React with 2-space indentation, single quotes, trailing commas, and semicolons as produced by Prettier. Imports are sorted by `@trivago/prettier-plugin-sort-imports`, then Tailwind classes by `prettier-plugin-tailwindcss`. Use PascalCase for React components (`ChatInput.tsx`), camelCase for hooks and utilities (`useAsyncChat.ts`, `backendApi.ts`), and keep domain-specific files near their owning feature folder.

## Testing Guidelines

Vitest runs in `jsdom` with globals enabled. Name tests `*.test.ts` or `*.test.tsx` and place them under `__tests__/` using the source path as a guide, such as `__tests__/utils/app/api.test.ts`. Coverage includes `utils`, `components`, `services`, `hooks`, and `pages/api`, with 80% thresholds for lines, functions, branches, and statements. Add or update focused tests for API behavior, stores, hooks, and utility changes.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Fix optional Exa search config validation` or `Expose autonomous queue visibility`. Keep commits scoped and avoid unrelated formatting churn. Pull requests should describe the change, list verification commands, link related issues, and include screenshots or recordings for UI changes. Call out impacts to `env.example`, auth, Redis-backed state, websocket behavior, or PWA caching.

## Security & Configuration Tips

Do not commit secrets. Use `env.example` and `auth-passwords.json.template` as templates only. Production secrets such as `SESSION_SECRET`, Redis settings, backend routing variables, and internal API tokens must come from environment variables or deployment secrets.
