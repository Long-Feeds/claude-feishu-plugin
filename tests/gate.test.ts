import { test, expect } from "bun:test"
import { gate, type FeishuEvent } from "../src/gate"
import { defaultAccess } from "../src/access"

function evt(overrides: Partial<FeishuEvent["message"]> & { sender?: string } = {}): FeishuEvent {
  return {
    event_id: "ev1",
    sender: { sender_id: { open_id: overrides.sender ?? "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_1", create_time: "0",
      chat_id: overrides.chat_id ?? "oc_1",
      chat_type: overrides.chat_type ?? "p2p",
      message_type: overrides.message_type ?? "text",
      content: overrides.content ?? '{"text":"hi"}',
      thread_id: overrides.thread_id,
    },
  }
}

test("p2p allowlisted user → deliver", () => {
  const a = defaultAccess(); a.dmPolicy = "allowlist"; a.allowFrom = ["ou_abc"]
  expect(gate(evt({ sender: "ou_abc" }), a, "ou_bot").action).toBe("deliver")
})

test("p2p allowlist strict drops unknown", () => {
  const a = defaultAccess(); a.dmPolicy = "allowlist"; a.allowFrom = ["ou_abc"]
  expect(gate(evt({ sender: "ou_other" }), a, "ou_bot").action).toBe("drop")
})

test("p2p pairing mode issues code", () => {
  const a = defaultAccess()
  const r = gate(evt({ sender: "ou_new" }), a, "ou_bot")
  expect(r.action).toBe("pair")
})

test("group without policy entry drops", () => {
  const a = defaultAccess()
  expect(gate(evt({ chat_type: "group", chat_id: "oc_group" }), a, "ou_bot").action).toBe("drop")
})

test("disabled mode drops", () => {
  const a = defaultAccess(); a.dmPolicy = "disabled"; a.allowFrom = ["ou_abc"]
  expect(gate(evt({ sender: "ou_abc" }), a, "ou_bot").action).toBe("drop")
})

test("group @mention matches configured botOpenId", () => {
  const a = defaultAccess()
  a.groups["oc_g"] = { requireMention: true, allowFrom: [] }
  const e = evt({ chat_type: "group", chat_id: "oc_g" })
  e.message.mentions = [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "bot" }]
  expect(gate(e, a, "ou_bot").action).toBe("deliver")
})

test("group @mention does not match when botOpenId unresolved", () => {
  // Regression guard: empty botOpenId must not silently match every mention.
  // If Feishu's /bot/v3/info call failed and FEISHU_BOT_OPEN_ID wasn't set,
  // we'd rather drop than accept arbitrary @s. requireMention group with
  // no mentionPatterns fallback must drop here.
  const a = defaultAccess()
  a.groups["oc_g"] = { requireMention: true, allowFrom: [] }
  const e = evt({ chat_type: "group", chat_id: "oc_g" })
  e.message.mentions = [{ key: "@_user_1", id: { open_id: "ou_someone_else" }, name: "x" }]
  expect(gate(e, a, "").action).toBe("drop")
})

test("group mentionPatterns fallback delivers even when botOpenId empty", () => {
  const a = defaultAccess()
  a.groups["oc_g"] = { requireMention: true, allowFrom: [] }
  a.mentionPatterns = ["claude"]
  const e = evt({ chat_type: "group", chat_id: "oc_g", content: '{"text":"hi claude"}' })
  expect(gate(e, a, "").action).toBe("deliver")
})
