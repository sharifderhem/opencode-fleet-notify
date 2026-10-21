#!/usr/bin/env node
// Mock fleet-notification server for local development of opencode-fleet-notify.
// Serves a static feed (one info + one requires_ack critical notification),
// honors If-None-Match, and logs acks. No dependencies.
//
//   node scripts/mock-server.mjs [port]     (default port 8787)

import { createServer } from "node:http"
import { createHash } from "node:crypto"

const port = Number(process.argv[2]) || 8787

const feed = {
  version: 1,
  items: [
    {
      id: "welcome-info",
      type: "notification",
      severity: "info",
      title: "Welcome to the fleet",
      body: "This is a mock info notification from the local dev server.",
      link: "https://fleet.example.com/notices/welcome-info",
      requires_ack: false,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    },
    {
      id: "critical-maint",
      type: "notification",
      severity: "critical",
      title: "Planned maintenance",
      body: "The mock gateway will be unreachable for 10 minutes. This notice requires acknowledgement.",
      link: "https://fleet.example.com/notices/critical-maint",
      requires_ack: true,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    },
  ],
}

const acked = new Set()

function etag() {
  const visible = feed.items.filter((i) => !i.requires_ack || !acked.has(i.id))
  return createHash("sha1").update(JSON.stringify(visible)).digest("hex")
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`)

  if (url.pathname === "/feed" && req.method === "GET") {
    const tag = etag()
    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, { etag: tag })
      res.end()
      return
    }
    const types = url.searchParams.get("types")
    const items = feed.items.filter(
      (i) =>
        (!types || i.type === types) &&
        Date.parse(i.expires_at) > Date.now() &&
        !(i.requires_ack && acked.has(i.id)),
    )
    res.writeHead(200, { "content-type": "application/json", etag: tag })
    res.end(JSON.stringify({ version: 1, etag: tag, items }, null, 2))
    return
  }

  const ackMatch = url.pathname.match(/^\/ack\/(.+)$/)
  if (ackMatch && req.method === "POST") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const id = decodeURIComponent(ackMatch[1])
      acked.add(id)
      console.log(`ACK received: id=${id} body=${body}`)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, id }))
    })
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(port, "127.0.0.1", () => {
  console.log(`mock fleet server listening on http://localhost:${port}`)
  console.log(`set FLEET_NOTIFY_URL=http://127.0.0.1:${port} and FLEET_NOTIFY_API_KEY=dev-key`)
})
