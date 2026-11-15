# Product facts (verified)

Last verified: 2026-11-15. Keep this file current when the API or upstream app
changes; design and copy must be based on these facts, not memory.

## DeepSeek API

| Fact | Source |
| --- | --- |
| Models: `deepseek-flash` (DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro` (DeepSeek-V4-Pro-0813). | https://api-docs.deepseek.com/quick_start/pricing |
| 1M token context; up to 384K output tokens; thinking is enabled by default and supports low/high/max effort. | https://api-docs.deepseek.com/quick_start/pricing, https://api-docs.deepseek.com/guides/thinking_mode |
| Flash prices per 1M tokens: cache hit $0.003 off-peak / $0.006 peak, cache miss $0.15 / $0.30, output $0.60 / $1.20. Peak is Mon–Fri 01:00–04:00 and 06:00–10:00 UTC excluding CN holidays. | https://api-docs.deepseek.com/quick_start/pricing |
| No embeddings endpoint. | https://api-docs.deepseek.com/sitemap.xml (no embeddings page; no endpoint in the API reference) |
| No fine-tuning endpoint on `api.deepseek.com`. | Same: no fine-tuning page/endpoint; the 2025 note only permits using outputs for training elsewhere. |
| Anthropic-compatible base URL is `https://api.deepseek.com/anthropic`; `x-api-key` or `Authorization: Bearer`; SSE without `[DONE]`; usage in the final `message_delta` is cumulative. | https://api-docs.deepseek.com/guides/anthropic_api |
| Extensions: `thinking`, server tools `deepseek_web_search`/`deepseek_read_url`, `safety_check`, `title`, `latest_reminder` role, anthropic-beta `files-api-2025-04-14`. | https://api-docs.deepseek.com/guides/anthropic_api |
| Search and Fetch are directly callable: `POST /v1/tools/search`, `POST /v1/tools/fetch`; $0.75 per 1,000 successful requests. | https://api-docs.deepseek.com/guides/search |
| OCR is directly callable: `POST /v1/tools/ocr`, returns per-page text; $0.225 per 1,000 pages; 15 concurrent recognitions. | https://api-docs.deepseek.com/guides/ocr |
| Files API parses documents but originals and parsed text cannot be downloaded. | https://api-docs.deepseek.com/guides/files_api |
| Structured output: Responses API supports JSON schema (`text.format`); Chat Completions supports `json_object`; Anthropic format ignores `output_config`. | https://api-docs.deepseek.com/guides/responses_api, https://api-docs.deepseek.com/guides/json_mode |
| The API is stateless: no stored conversations, batches or request logs. Cache is best-effort prefix caching. | https://api-docs.deepseek.com/guides/kv_cache |
| CORS reflects arbitrary origins with credentials; a browser-only app exposes its key. | Verified preflight to `/anthropic/v1/messages` on 2026-11-15. |

## chat-demo upstream

| Fact | Source |
| --- | --- |
| MIT, static React 18 + rspack app; no backend; API key in localStorage; conversations in IndexedDB. | https://github.com/deepseek-ai/chat-demo |
| API origin is a build-time constant (`__API_ORIGIN__`); the default export builds against `https://api.deepseek.com`. | `rspack.config.ts` lines 26–30, 83, 93 |
| Calls `/models`, `/anthropic/v1/messages`, `/anthropic/v1/files`, `/v1/tools/asr`, `/v1/tools/tts`. | `src/services/api/client.ts`, `src/services/api/speech.ts` |
| Unknown SSE payload types are silently dropped, but the whole `usage` object is stored on the assistant message. | `src/services/api/parseEvent.ts`, `src/services/chat/reply.ts` |
| Full visible history is re-sent every turn; the final user message is the only safe place to append retrieval context without breaking prefix caching or thinking signatures. | `src/services/chat/reply.ts`, upstream protocol notes |
| No router, no tests; CSS Modules and DeepSeek design tokens (`--dsw-alias-*`) drive light/dark themes. | `src/app/App.tsx`, `src/app/theme.css` |
| The default read-aloud voice is named “Stella”. | `src/i18n/en.ts` |

## Stella boundaries

- Real: chat, streaming, attachments, voice, markdown, branching, history import/export (upstream); gateway capture; retrieval over local collections; cost/latency; datasets; evaluation runner; judge; gates; FT data exports.
- External: any fine-tuning execution (DeepSeek does not offer it). Stella generates validated data and provider plans; it never claims a tuned model ran.
- Simulated/replay: CI and demo replay from recorded cassettes are labeled as replay; they prove mechanics, not live model quality.
