// NDJSON line framing and shared IPC types for the daemon ↔ shim socket.

export function frame(msg: unknown): string {
  return JSON.stringify(msg) + "\n"
}

export class NdjsonParser {
  private buf = ""

  feed(chunk: string, onMessage: (msg: unknown) => void): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        // Skip malformed lines; log is left to caller if desired.
      }
    }
  }
}

// ─── Shim → daemon requests ─────────────────────────────────────────────

export type RegisterReq = {
  id: number
  op: "register"
  session_id: string | null
  pid: number
  cwd: string
  // The tmux window the shim is running inside, resolved from $TMUX_PANE.
  // Daemon stores this on the SessionEntry so inbound feishu messages can be
  // send-keys'd back into the right pane. Unset when shim runs outside tmux
  // (terminal-origin sessions don't need this — they receive via MCP push).
  tmux_window_name?: string
}

export type ReplyReq = {
  id: number
  op: "reply"
  text: string
  files?: string[]
  format?: "text" | "post" | "markdown"
  reply_to?: string | null
}

export type ReactReq = {
  id: number
  op: "react"
  message_id: string
  emoji_type: string
}

export type EditReq = {
  id: number
  op: "edit_message"
  message_id: string
  text: string
  format?: "text" | "post" | "markdown"
}

export type DownloadReq = {
  id: number
  op: "download_attachment"
  message_id: string
  file_key: string
  type: "image" | "file"
}

export type PermissionReq = {
  id: number
  op: "permission_request"
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type SessionInfoReq = {
  id: number
  op: "session_info"
  claude_session_uuid: string
}

// External Stop-hook post: the plugin's `hooks/mirror-stop.ts` fires after
// every Claude turn, extracts the last assistant message text, and ships it
// here so the daemon can mirror it to the feishu thread for this session.
// The hook is NOT a registered shim — it's a one-shot connection from a
// separate process — so it supplies its own (claude_session_uuid, cwd)
// instead of relying on socket state.
export type HookPostReq = {
  id: number
  op: "hook_post"
  claude_session_uuid: string
  cwd: string
  text: string
}

// External UserPromptSubmit-hook post: fires each time the user submits a
// prompt in a terminal-origin session. Daemon uses the FIRST such prompt as
// the title of the hub announce (before this, register-time announces used
// a generic "Claude Code session online" string, which gave operators no
// clue what the session was working on). Subsequent prompts are no-ops.
export type UserPromptReq = {
  id: number
  op: "user_prompt"
  claude_session_uuid: string
  cwd: string
  prompt: string
}

export type ShimReq =
  | RegisterReq
  | ReplyReq
  | ReactReq
  | EditReq
  | DownloadReq
  | PermissionReq
  | SessionInfoReq
  | HookPostReq
  | UserPromptReq

// ─── Daemon → shim responses & pushes ───────────────────────────────────

export type DaemonResp =
  | { id: number; ok: true; [k: string]: unknown }
  | { id: number; ok: false; error: string }

export type InboundMeta = {
  chat_id: string
  message_id: string
  thread_id?: string
  user: string
  user_id: string
  ts: string
  image_path?: string
  attachment_file_key?: string
  attachment_kind?: string
  attachment_name?: string
}

export type DaemonPush =
  | { push: "inbound"; content: string; meta: InboundMeta }
  | { push: "initial_prompt"; content: string }
  | { push: "permission_reply"; request_id: string; behavior: "allow" | "deny" }
  | { push: "shutdown"; reason: string }

export type DaemonMsg = DaemonResp | DaemonPush
