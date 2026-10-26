# opencode-fleet-notify

Fleet notifications, additive LiteLLM skill sync, automatic MCP gateway access,
and native model metadata for OpenCode. Version **0.7.0** adds MCP support on V1
and V2; version **0.6.0** added skills and metadata support.

Version **0.5.1** adds OpenCode 2.1.1 server and
terminal support with explicit acknowledgments. Version 0.5.1 fixes the published
TUI loading failure by deferring the legacy entry and installing its Solid runtime
dependency. The agreed scope is terminal support; immediate desktop/web delivery
remains explicitly unresolved.

Version **0.6.1** fixes desktop server loading by shipping compiled JavaScript.
The desktop's Node runtime does not resolve `.js` imports to TypeScript source
files as the terminal's Bun runtime does. Tests now exercise the installed
desktop's embedded server as well as both CLI generations.

Put shared provider/model and plugin configuration in
`~/.config/opencode/opencode.json(c)` so it applies inside Git projects too.
A `~/opencode.json` file is an ancestor project configuration and V1 stops
searching for that file at the project's worktree boundary.

## LiteLLM skills, MCP, and model metadata

The plugin automatically reads LiteLLM's existing `/claude-code/plugins` and
`/model/info` endpoints and derives its aggregate `/mcp` endpoint using the
configured provider's base URL and matching API key. A trailing `/v1` is removed
while proxy prefixes such as `/api` are preserved. No dashboard endpoint or extra
credential is needed. Skills/metadata were introduced in 0.6.0 and MCP in 0.7.0.

The provider named `litellm` is selected automatically. Otherwise, the plugin uses
an unambiguous provider matching the notification URL's origin. Set plugin option
`provider` to select a different ID explicitly. Set `skills: false`, `mcp: false`,
or `modelMetadata: false` to disable a feature. Notification credential overrides
do not override the LiteLLM provider's credential.

### Additive skills sync

- Sync the catalog visible to that key at startup, on new sessions, and every five
  minutes. Skills live on the OpenCode server in
  `$XDG_CONFIG_HOME/opencode/skills` (normally `~/.config/opencode/skills`).
- Download the catalog's external sources without sending the LiteLLM key.
  Supported sources: public HTTPS GitHub/Git repositories, Git subdirectories,
  and direct HTTPS ZIP archives. Git sources require Git on the server; refs must
  be branch/tag names. Private source authentication and tar archives are not
  supported. Archive URLs must resolve directly without an HTTP redirect.
- Install `SKILL.md` subtrees and their supporting files, not arbitrary plugin
  hooks, commands, or MCP registrations. Files are stored as regular files;
  bundled scripts should be invoked through their interpreter.
- Preserve personal skill names and any locally modified managed skill, including
  added files. Conflicts are skipped and logged. Removed catalog entries do not
  delete local skills. The hidden `.fleet-state.json` tracks ownership and hashes.
- A stable catalog version or archive digest avoids downloading unchanged skills.
  Publishers must change the version when content changes. Without a version or
  digest, the source is fetched again to compare file hashes; unchanged files are
  not rewritten.
- Downloads and extraction are bounded; unsafe paths and Git symlinks are refused.
  Syncs are serialized, with recovery for locks left by exited processes.
- V2 reloads skill discovery after writes. V1 discovers the folder normally;
  an already-open project may need a reload to refresh cached skill listings.

### Automatic MCP gateway

- One in-memory remote entry named `fleet-litellm` connects to the provider's
  aggregate `/mcp` route. For a provider base URL of
  `https://gateway.example.com/api`, the MCP URL is
  `https://gateway.example.com/api/mcp`.
- The connection sends the developer key only as
  `x-litellm-api-key: Bearer <key>` and disables OAuth for this API-key connection.
  LiteLLM returns only tools allowed to that key/team and enforces permissions on
  every call. Upstream MCP URLs and credentials are never copied to the client.
- Existing OpenCode configuration is unchanged: no provider, model, plugin, or MCP
  edits are required, and saved config is never rewritten. A developer-owned
  `fleet-litellm` collision is preserved and logged instead of overwritten.
- New sessions and the existing five-minute cycle refresh the managed connection
  so newly permitted tools are discovered. Startup retries avoid reconnect loops.
  V2 reconciles only this entry; V1 reconnects it through OpenCode's MCP API.
- Updating/reloading the plugin enables the feature by default. Set `mcp: false`
  in the existing plugin options to opt out. LiteLLM with no permitted MCP tools
  simply provides an empty catalog.
- MCP tool descriptions consume model context. Administrators should expose
  appropriately scoped servers/tools rather than an unnecessarily large catalog.

To confirm operation, run `opencode mcp list` or inspect OpenCode's MCP status:
`fleet-litellm` should be connected and permitted tools should be available. Ask
for a harmless tool explicitly by name and verify its real result. A direct
`tools/list` request to the same `/mcp` URL with that developer key must show only
the key's permitted catalog; a denied key must not be able to call those tools.

### Native model fields

LiteLLM prices are converted from dollars per token to OpenCode's dollars per
million tokens. Reported input/output limits and prices enrich the existing model
metadata. V1 uses an in-memory configuration hook; V2 uses a provider transform.
Saved OpenCode configuration is not rewritten by the plugin.

Missing/null data preserves existing values. Duplicate deployment aliases are
skipped. V2 context-tier pricing is preserved, and a model without a cost baseline
needs all four prices (input/output/cache read/cache write) before a baseline can
be created. V1 only writes valid complete cost/limit objects. The plugin cannot
supply a context limit LiteLLM does not report. V1 metadata refreshes on project
configuration reload; V2 also refreshes with the sync cycle.

OpenCode's Context **Usage** remains context percentage and **Total Cost** remains
session cost calculated by OpenCode. Pricing changes affect subsequent accounting;
existing message costs are not retroactively rewritten. These values are not
LiteLLM's daily invoice totals. No daily key-spend field or new UI is added.

### Local verification

Run `npm run build`, `npm run typecheck`, and `npm test`. Real-host fixture checks use temporary HOME
and XDG directories, fake LiteLLM responses, a local HTTPS archive server, and a
streamable-HTTP MCP server:

```sh
OPENCODE_BINARY=/path/to/opencode npm run test:features:host
OPENCODE_BINARY=/path/to/opencode-v1 npm run test:features:host -- --legacy
```

On Linux with OpenCode desktop installed, `npm run test:desktop` exercises its
actual embedded Node server. Set `OPENCODE_DESKTOP_APP` and
`OPENCODE_DESKTOP_ASAR` for non-default installation paths.

The fixture requires OpenSSL. It makes no model calls and never uses a real key.
It checks MCP connection, tool discovery, a harmless call, denied credentials,
new-tool refresh, offline recovery, and byte-for-byte unchanged saved config.

## OpenCode 2 installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "opencode-fleet-notify@0.7.0",
    "options": { "url": "https://gateway.example.com/api/fleet" }
  }]
}
```

The terminal entry point loads automatically alongside the server entry point.
For a local checkout, replace the package name with its absolute directory path.
Restart/reload OpenCode after changing the configuration.

If the gateway serves `/.well-known/fleet-notify` with a `feed_url` on the same
origin, the package name alone is enough. The plugin uses OpenCode's resolved
provider configuration (including JSONC and environment/file substitutions).

Server URL precedence:

1. Plugin `options.url`.
2. `FLEET_NOTIFY_URL`.
3. `$XDG_CONFIG_HOME/opencode/fleet-notify.json` (`~/.config` by default), with `{"url":"..."}`.
4. Discovery from configured provider `settings.baseURL` origins.

Credentials: an explicit `FLEET_NOTIFY_API_KEY` takes precedence. Otherwise the
plugin selects the provider matching the gateway origin, using its active key
integration before `settings.apiKey`. It never takes an arbitrary credential from
another provider. For a separately hosted fleet service, or ambiguous providers,
set `options.provider` to the gateway's provider ID alongside `options.url`.
Cross-origin discovery is ignored; explicit configuration is required.

## Notifications and acknowledgments

- Poll once at startup and on new root sessions, then roughly every 90 seconds
  with jitter and exponential failure backoff. Discovery retries if provider
  configuration is not ready during plugin startup.
- Terminal: first-seen notices open a center dialog. Required notices offer
  **Acknowledge** and **Later**. Later/Escape never records an acknowledgment;
  required notices reappear after approximately 90 seconds.
- Confirming sends an immediate receipt. Success is shown only after a successful
  backend response. Failed receipts remain queued for retry across restarts.
- **There is no auto-ack after repeated displays.** A 404 is not a receipt.
- At most five dialogs per batch. New notices take priority over repeat reminders.
- `/fleet-notices` opens the terminal inbox immediately, including already-seen
  notices. Select a notice to read it and acknowledge it if required.
- `/fleet-ack <id>` is an explicit server command for acknowledging a notice.
- Full and notification-only feeds use separate ETags. Removed/expired notices
  leave the active list. Unknown item types are ignored.
- V2 state uses OpenCode plugin storage, scoped by location and a hash of the
  server URL/key. Credentials are not stored in that state. Old V1 automatic
  receipt state is not imported as proof of human acknowledgment.

### Desktop and web limitation (verified on 2.1.1)

**Immediate desktop/web notification rendering is unresolved.** Terminal plugins
cannot supply desktop dialogs. The actual host's `session.synthetic` with
`resume: false` puts input into a pending inbox; an idle web session shows neither
that input nor a notification. It does not append a visible transcript message.

`options.sessionMessages: true` opts into queueing notices for the next normal
session turn. It is **off by default**, does not start a model turn, and is not an
immediate notification solution. `/fleet-notices` is a terminal UI command.
The `/fleet-ack` command performs the receipt immediately, but its textual feedback
uses this same queued-message API. Terminal dialog feedback is immediate.

## OpenCode 1 compatibility

The package retains the official dual-generation export. V1 **1.18.29+** calls
`server()` and the legacy `tui()` entry; V2 calls `setup()` on both entries. Use
V1's singular `plugin` configuration and tuple options on those hosts:

```json
{"plugin": [["opencode-fleet-notify@0.7.0", {"url":"https://gateway.example.com/api/fleet"}]]}
```

The retained legacy path also removes three-display auto-acknowledgment and adds
network deadlines. It still uses its original file bridge, credential resolution,
and `fleet_ack` tool. MCP registration, dynamic refresh, denied credentials, and
offline recovery are exercised against the installed desktop's embedded V1 server.

## Protocol

`GET {url}/feed` returns `{ "version": 1, "etag": "...", "items": [...] }`.
Interval polls use `?types=notification`; `If-None-Match` allows 304 responses.
Requests authenticate with the gateway key in the Bearer header.

```json
{
  "id": "maintenance-1",
  "type": "notification",
  "severity": "critical",
  "title": "Planned maintenance",
  "body": "Gateway restart tonight.",
  "requires_ack": true,
  "expires_at": "2026-12-01T00:00:00Z"
}
```

`POST {url}/ack/{id}` sends `{ "action": "ack" }`. Any successful HTTP response
confirms receipt; other responses retry. Acknowledgments are idempotent server-side.
The plugin sends no code, prompts, or session contents to the fleet service.
Skill synchronization and automatic MCP gateway registration are implemented as described above.

## Development and verification

```sh
npm install
npm run typecheck
npm test
npm run mock-server
OPENCODE_BINARY=/absolute/path/to/opencode node scripts/verify-host.mjs
OPENCODE_BINARY=/absolute/path/to/opencode node scripts/verify-host.mjs --discovery
```

The host check uses temporary configuration/storage, localhost fixtures and a
fake key. It checks real plugin loading, entry discovery, feed retrieval, explicit
slash-command acknowledgment, reload persistence and zero model output tokens.
It does not publish, contact production, or alter the user's OpenCode configuration.
Pass an extracted package directory as its argument to check a packed artifact.

Manual verification on **OpenCode 2.1.1**, 2026-10-21:

- Actual terminal displayed both the information dialog and the required notice's
  **Later / Acknowledge** dialog.
- Confirm produced an actual mock-backend receipt and an acknowledgment-success toast.
- `/fleet-notices` and the Fleet notices palette action both opened the live
  terminal inbox; selecting a previously seen notice displayed its full text.
- Actual web UI stayed blank while `resume:false` notices were in the inbox;
  desktop support is therefore not claimed.

Official references: [migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1/),
[CLI dialogs](https://opencode.ai/v2/docs/build/plugins/cli/),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc/).

MIT — see LICENSE.
