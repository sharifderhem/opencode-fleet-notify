import { Rpc } from "@opencode/plugin/rpc"

const id = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } as const

export const Fleet = Rpc.define({
  id: "fleet-notify",
  methods: {
    list: { input: { type: "null" }, output: { type: "array", items: { type: "object" } } },
    seen: { input: id, output: { type: "null" } },
    acknowledge: { input: id, output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
  },
  events: {},
})
