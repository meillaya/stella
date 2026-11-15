# Contributing

Stella is a fork of [chat-demo](https://github.com/deepseek-ai/chat-demo) with a
local-first workbench. Keep the upstream chat engine stable; add product code in
the Stella scopes.

## Setup

```bash
pnpm install
cp .env.example .env.local   # optional for live work
pnpm type
pnpm test
pnpm test:ui
pnpm build
```

Node 24+, pnpm 11+. No Python/Nix/Docker required. The pnpm store and cache are
configured in `pnpm-workspace.yaml` to live inside the repo (host caches are
read-only in some environments).

## Where code goes

| Area | Path |
| --- | --- |
| Chat app (forked upstream) | `src/app`, `src/components`, `src/services`, `src/i18n` |
| Stella shell/workbench | `src/stella/` (`ui`, `shell`, `pages`, `workbench`, `stella.css`) |
| Server/gateway/API | `server/src/` |
| Shared contracts | `shared/` |
| Demo content | `corpus/`, `datasets/`, `fixtures/` |
| Docs | `docs/`, `README.md`, `UPSTREAM.md` |

Rules:

- Server/shared/test TypeScript uses explicit `.ts` import specifiers and
  erasable-only syntax (no enums, parameter properties or namespaces); Node 24
  strips types at runtime.
- App code follows upstream conventions: `.js` specifiers, CSS Modules for
  upstream components, the global `st-*` classes for Stella surfaces.
- Do not edit upstream files casually; if you must, add the file to the table in
  `UPSTREAM.md`.
- Never commit API keys, `.env.local`, `data/`, cassettes with customer content,
  or generated `dist/`.

## Quality gates

```bash
pnpm lint        # oxlint
pnpm type        # app + server tsc
pnpm test        # node:test server tests (no live calls)
pnpm test:ui     # vitest + jsdom
pnpm build       # rspack production build
```

Tests must not call the live API. Use fixtures/mock upstreams and ephemeral
ports. A replay miss is a failure, not a reason to invent data.

## Commits and review

- One coherent change per commit; explain the *why* in the body if the diff is
  not self-evident.
- Review the final diff and run the gates; the Lead owns the final integration.
- Record design-taste feedback in the huashu-design local profile only if the
  user asked for it.

## Upstream sync

Follow [`UPSTREAM.md`](../UPSTREAM.md): pin, diff `src/`, apply upstream fixes to
the preserved paths, keep Stella-only code in `src/stella/`, update the modified
file table, and re-run the chat smoke test.
