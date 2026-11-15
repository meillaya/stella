# API Reference

The Meridian API is served over HTTPS and uses bearer authentication. All
responses are JSON.

## Names

The getUserName endpoint resolves a display name for a numeric user id.
Client libraries expose it as `get_user_name` and as `get-user-name` in the CLI,
so all three spellings are searchable.

## Rate limits

Requests are limited to 120 per minute per workspace. When the limit is hit the
API returns HTTP 429 with a Retry-After header. The parse_retry_count helper
reads that header and returns the number of seconds to wait.

## Example

```ts
const name = await getUserName({ userId: 42 })
const waitSeconds = parse_retry_count(response.headers)
await sleep(waitSeconds * 1000)
```

## C++ client note

The official C++ client wraps the same endpoints. A `"quoted phrase"` in the
query examples is matched literally by the API documentation search tool.
