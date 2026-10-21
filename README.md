# opencode-fleet-notify

Fleet notifications, additive LiteLLM skill sync, and native model metadata for
OpenCode. Version **0.6.0** adds skills and metadata support on V1 and V2.

Version **0.5.1** adds OpenCode 2.1.1 server and
terminal support with explicit acknowledgments. Version 0.5.1 fixes the published
TUI loading failure by deferring the legacy entry and installing its Solid runtime
dependency. The agreed scope is terminal support; immediate desktop/web delivery
remains explicitly unresolved.

## LiteLLM skills and model metadata (0.6.0)

Version 0.6.0 automatically reads LiteLLM's existing
`/claude-code/plugins` and `/model/info` endpoints using the configured provider's
base URL and matching API key. A trailing `/v1` is removed while proxy prefixes
such as `/api` are preserved. No dashboard endpoint or extra credential is needed.
These additions were introduced in 0.6.0.

The provider named `litellm` is selected automatically. Otherwise, the plugin uses
an unambiguous provider matching the notification URL's origin. Set plugin option
`provider` to select a different ID explicitly. Set `skills: false` or
`modelMetadata: false` to disable that feature. Notification credential overrides
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

Run `npm run typecheck` and `npm test`. Real-host fixture checks use temporary HOME
and XDG directories, fake LiteLLM responses, and a local HTTPS archive server:

```sh
OPENCODE_BINARY=/path/to/opencode npm run test:features:host
OPENCODE_BINARY=/path/to/opencode-v1 npm run test:features:host -- --legacy
```

The fixture requires OpenSSL. It makes no model calls and never uses a real key.

## OpenCode 2 installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "opencode-fleet-notify@0.6.0",
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
{"plugin": [["opencode-fleet-notify@0.6.0", {"url":"https://gateway.example.com/api/fleet"}]]}
```

The retained legacy path also removes three-display auto-acknowledgment and adds
network deadlines. It still uses its original file bridge, credential resolution,
and `fleet_ack` tool. V1 runtime compatibility has not been re-tested with a V1
binary in this change; the live verification below is specifically 2.1.1.

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
Skills/MCP synchronization is not implemented by this release.

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
