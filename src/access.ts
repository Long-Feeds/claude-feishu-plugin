import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: "pairing" | "allowlist" | "disabled"
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  hubChatId?: string
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: "off" | "first" | "all"
  textChunkLimit?: number
  chunkMode?: "length" | "newline"
}

export function defaultAccess(): Access {
  return {
    dmPolicy: "pairing",
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

export function loadAccess(file: string): Access {
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? "pairing",
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      hubChatId: parsed.hubChatId,
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return defaultAccess()
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return defaultAccess()
  }
}

export function saveAccess(file: string, a: Access): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

export function setHubChatId(file: string, chatId: string): void {
  const a = loadAccess(file)
  a.hubChatId = chatId
  saveAccess(file, a)
}
