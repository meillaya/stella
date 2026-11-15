# Upstream provenance

Stella is a fork of [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo).

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/deepseek-ai/chat-demo |
| Upstream tag | `v0.1.1` |
| Upstream commit | `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c` |
| Imported | 2026-11-15 |
| License | MIT, Copyright (c) 2026 DeepSeek (see `LICENSE`) |

The upstream source layout under `src/` is preserved so that a future upstream
release can be diffed against Stella. New product code lives in `src/stella/`
(app), `server/` (gateway, RAG, evals, CLI) and `shared/` (contracts).

## Modified upstream files

Keep this list current. Prefer new files and small, documented edits.

| File | Change |
| --- | --- |
| `package.json` | Renamed to `stella`; server/UI/test scripts and dependencies added. |
| `tsconfig.json` | Added `allowImportingTsExtensions`; includes Stella-specific config files. |
| `rspack.config.ts` | Same-origin build (`apiOrigin: ''`), dev proxy to the Stella server, `__STELLA__` flag. |
| `.gitignore` | Added Stella runtime data, caches and test artifacts. |
| `src/index.html` | Stella title, description and favicon. |
| `src/env.d.ts` | Added the `__STELLA__` build flag type. |
| `README.md` | Replaced with Stella documentation. |
| `README.zh-CN.md` | Removed; Stella documentation will be maintained in one place. |
| `.github/workflows/pages.yml` | Removed; replaced by Stella CI. |

Files expected to change during the build (tracked here as they land):
`src/app/App.tsx`, `src/components/sider/Sider.tsx`,
`src/components/messages/AssistantMessage.tsx`,
`src/components/chatInput/ChatInput.tsx`,
`src/components/settings/SettingsDialog.tsx`, `src/services/settings.ts`,
`src/services/api/types.ts`, `src/i18n/en.ts`, `src/i18n/zh.ts`,
`src/app/theme.css`.

## Sync policy

1. Fetch the upstream release tag and compare:
   `git remote add chat-demo https://github.com/deepseek-ai/chat-demo` (once)
   `git fetch chat-demo --tags`
   `git diff 5d5dd75..<new-tag> -- src`
2. Apply upstream fixes to the preserved paths; keep Stella changes isolated in
   `src/stella/` and the small edit set above.
3. Update this file and run the chat smoke test (`pnpm test:e2e:chat` when it exists).
4. Never copy upstream `dist/`, `node_modules/` or secrets.
