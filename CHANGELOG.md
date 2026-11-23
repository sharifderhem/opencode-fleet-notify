# Changelog

## 0.8.1

- Background skills and MCP catalog refresh now runs every hour instead of every five minutes
  (option `refreshMinutes`, default 60, minimum 5). Idle clients were generating `list_mcp_tools`
  traffic every ~2.5 minutes. Notification polling is unchanged. Startup refresh, fast startup
  retries and the session-created refresh are unchanged; a refresh still re-lists MCP tools so new
  gateway tools are discovered.

## 0.8.0 (2026-11-23)

- Fix: git skill sources (git-subdir/github/url) fetched each file lazily from a partial clone (about 25 s for 22 files) and the sync failed; now one batched sparse checkout (about 1 s). Failed sources report the reason.

- Staleness detection: once per 24 h the plugin queries the public npm registry
  (no auth, 4 s timeout, failure tolerant) and tells the user how to upgrade.
  Opt out with `updateCheck: false` or `FLEET_NOTIFY_UPDATE_CHECK=0`.
- `/fleet-doctor` command (V1 and V2) and per-feature status
  (`ok` / `skipped:<reason>` / `failed:<error>`), secrets masked.
- Low-noise log file `fleet-notify.log` (size capped, single backup) in the XDG state dir.
- Runtime capability detection instead of version checks; `AbortSignal.any` fallback
  for Node < 20.3; notifications, skills, MCP and metadata isolated from one another.
- Fixed stale `X-Fleet-Client` version header on the V1 path (was hard-coded 0.5.0).
- Unchanged: personal skills/MCP preserved, saved OpenCode config never rewritten,
  `mcp: false` opt-out.

## 0.7.1

- Hide Git helper console windows on Windows during skill sync.

## 0.7.0

- Automatic LiteLLM MCP gateway access (`fleet-litellm`) on V1 and V2.
