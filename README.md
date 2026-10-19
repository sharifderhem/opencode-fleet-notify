# opencode-fleet-notify

An [OpenCode](https://opencode.ai) plugin that polls a "fleet protocol" notification server and
shows its notices as toast notifications in the OpenCode TUI.

Use it to broadcast operational notices to a fleet of OpenCode users — maintenance windows,
deprecations, policy changes, incidents — without anyone having to check a dashboard.

## Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-fleet-notify"],
  "fleet-notify": {
    "url": "https://fleet.example.com"
  }
}
```

Or set the environment variable instead of the config key:

```sh
export FLEET_NOTIFY_URL=https://fleet.example.com
```

The URL is the entire configuration.

### API key resolution

The plugin authenticates with a bearer key, resolved in this order:

1. The first credential found in `~/.local/share/opencode/auth.json`
2. The `FLEET_NOTIFY_API_KEY` environment variable

If no key is found, the plugin disables itself silently (one `debug` line in the app log).
TODO for v0.2: also read provider `apiKey` entries from `opencode.json`.

## Behavior

- Polls `GET {url}/feed` once when a session is created (full feed), then every ~90 seconds
  with ±20% jitter, with `?types=notification` on interval polls.
- Renders each new notification as a TUI toast:
  - `info` → `info` variant, ~5 s
  - `warning` → `warning` variant, ~30 s
  - `critical` → `error` variant, ~60 s
- Items with `requires_ack: true` are re-toasted on every poll until acknowledged. Since a
  server-side plugin cannot register custom slash commands, acknowledgement is automatic:
  after an item has been shown 3 times, the plugin POSTs the ack itself. An LLM-callable
  `fleet_ack` tool is also registered so an agent can acknowledge a notice by id.
- At most 5 toasts per poll; any remainder is summarized as a `+N more notices` toast.
- Expired items (`expires_at` in the past) are ignored client-side as defense in depth.
- All failures are silent: network errors, 5xx, malformed feeds → the cycle is skipped with
  exponential backoff (capped at 15 minutes). The plugin never throws during load or hooks.

Local dedup state lives in `~/.local/state/opencode-fleet-notify/state.json`
(`lastEtag`, `ackedIds`, `notifiedIds`, per-item show counts).

## Fleet protocol

### `GET {url}/feed`

Request headers:

- `Authorization: Bearer <key>`
- `X-Fleet-Client: opencode-fleet-notify/<version>`
- `If-None-Match: <last etag>` (when the client has one)

Query parameters: optional `?types=notification` on interval polls.

Responses:

- `304 Not Modified` — nothing to do.
- `200 OK` — a feed envelope:

```json
{
  "version": 1,
  "etag": "abc123",
  "items": [
    {
      "id": "maint-2026-10-19",
      "type": "notification",
      "severity": "critical",
      "title": "Planned maintenance",
      "body": "Gateway restart at 02:00 UTC.",
      "link": "https://fleet.example.com/notices/maint-2026-10-19",
      "requires_ack": true,
      "expires_at": "2026-10-20T02:00:00Z"
    }
  ]
}
```

Item fields: `id` (string, required), `severity` (`info` | `warning` | `critical`), `title`,
`body`, `link`, `requires_ack` (boolean), `expires_at` (ISO 8601). Unknown `type` values are
ignored silently for forward compatibility; v0.1 handles only `notification`.

### `POST {url}/ack/{id}`

Body: `{ "action": "ack" }`. Must be idempotent; 2xx (and 404) count as acknowledged.

## Privacy

The API key is sent only to the server you configured, in the `Authorization` header. The
only data the plugin sends back is an ack receipt (`POST /ack/{id}`) after a `requires_ack`
notice has been displayed 3 times (or when the `fleet_ack` tool is invoked). No code, prompts,
or session content ever leaves your machine.

## Development

Requires Node 18+ (OpenCode itself runs plugins with Bun, loading TypeScript directly).

```sh
npm install
npm run typecheck     # tsc --noEmit
npm run mock-server   # serves a static feed on http://localhost:8787
```

To test locally, start the mock server, then add to a test `opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-fleet-notify"],
  "fleet-notify": { "url": "http://localhost:8787" }
}
```

and set `FLEET_NOTIFY_API_KEY=dev-key` (or have any entry in `~/.local/share/opencode/auth.json`).
The mock server logs every request, honors `If-None-Match`, and logs acks. To observe ETag/304
behavior, restart OpenCode after the first successful poll — the state file persists the ETag.

## License

MIT — see [LICENSE](LICENSE).
