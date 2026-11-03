# web (stack: ts)

Account site and patch notes. Not part of the game protocol.

```
src/
  pages/index.tsx, pages/account.tsx, pages/patch-notes.tsx
  lib/api.ts                       fetch wrappers for the account service
tests/
  unit/api.test.ts
  e2e/account.spec.ts              Playwright
```

Commands: `bun run typecheck`, `bun run lint`, `bun test`, `bunx playwright test`.
