import { randomBytes } from "crypto"
import type { Access } from "./access"

export type FeishuEvent = {
  event_id?: string
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string }
    sender_type: string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time: string
    update_time?: string
    chat_id: string
    thread_id?: string
    chat_type: string
    message_type: string
    content: string
    mentions?: Array<{
      key: string
      id: { union_id?: string; user_id?: string; open_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}

export type GateResult =
  | { action: "deliver" }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean }

export function gate(event: FeishuEvent, access: Access, botOpenId: string): GateResult {
  if (access.dmPolicy === "disabled") return { action: "drop" }
  const senderId = event.sender.sender_id?.open_id
  if (!senderId) return { action: "drop" }

  const chatType = event.message.chat_type
  if (chatType === "p2p") {
    if (access.allowFrom.includes(senderId)) return { action: "deliver" }
    if (access.dmPolicy === "allowlist") return { action: "drop" }
    // pairing
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: "drop" }
        p.replies = (p.replies ?? 1) + 1
        return { action: "pair", code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: "drop" }
    const code = randomBytes(3).toString("hex")
    const now = Date.now()
    access.pending[code] = {
      senderId, chatId: event.message.chat_id,
      createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1,
    }
    return { action: "pair", code, isResend: false }
  }

  if (chatType === "group") {
    const policy = access.groups[event.message.chat_id]
    if (!policy) return { action: "drop" }
    const groupAllowFrom = policy.allowFrom ?? []
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: "drop" }
    if ((policy.requireMention ?? true) && !isMentioned(event, access.mentionPatterns, botOpenId)) {
      return { action: "drop" }
    }
    return { action: "deliver" }
  }
  return { action: "drop" }
}

function isMentioned(event: FeishuEvent, extraPatterns: string[] | undefined, botOpenId: string): boolean {
  for (const m of event.message.mentions ?? []) {
    if (m.id.open_id === botOpenId) return true
  }
  let text = ""
  try { text = JSON.parse(event.message.content).text ?? "" } catch {}
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, "i").test(text)) return true } catch {}
  }
  return false
}
