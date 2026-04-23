#!/usr/bin/env bun
// UserPromptSubmit hook: fires each time the user submits a prompt. Ships
// the prompt text to the daemon so the FIRST such submission for a
// terminal-origin session can be used as the Feishu thread title. Fails
// silently and exits 0 — must never block the prompt submission.

import { readFileSync } from "fs"
import { debugLog, sendFrame } from "./lib"

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8")
  debugLog("prompt", `hook fired, stdin=${raw.length} bytes`)
  let payload: {
    session_id?: string
    cwd?: string
    prompt?: string
    hook_event_name?: string
  }
  try { payload = JSON.parse(raw) } catch {
    debugLog("prompt", `bad hook stdin payload`)
    process.exit(0)
  }
  if (!payload.cwd || !payload.prompt) {
    debugLog("prompt", `missing cwd/prompt`)
    process.exit(0)
  }
  // Skip any channel-wrapped inbound — Claude Code fires UserPromptSubmit
  // for MCP channel notifications too (bridge-hint, feishu reply, etc.),
  // and those must never become the thread title. The wrapper tag Claude
  // Code generates is of the form `<channel source="plugin:feishu:feishu" ...>`
  // (observed in the wild — earlier spec said `<channel source="feishu">`,
  // which is why an over-narrow filter let these leak through as titles).
  // Match the tag name only — whatever source string Claude Code picks.
  const trimmed = payload.prompt.trimStart()
  if (trimmed.startsWith("<channel ") || trimmed.startsWith("<channel>")) {
    debugLog("prompt", `channel-wrapped prompt — skipping announce`)
    process.exit(0)
  }
  // Belt-and-suspenders: filter the bridge-hint text in case Claude Code
  // ever delivers it without a channel wrapper (shouldn't happen — it's
  // pushed via push:inbound → channel notification — but if the hint
  // content itself bleeds through as a user prompt it must not win the
  // title slot).
  if (trimmed.startsWith("⚡ FEISHU BRIDGE")) {
    debugLog("prompt", `bridge-hint prompt — skipping announce`)
    process.exit(0)
  }
  try {
    await sendFrame({
      op: "user_prompt",
      claude_session_uuid: payload.session_id ?? "",
      cwd: payload.cwd,
      prompt: payload.prompt,
    })
    debugLog("prompt", `sent user_prompt session=${payload.session_id ?? "?"} len=${payload.prompt.length}`)
  } catch (err) {
    debugLog("prompt", `sendFrame failed: ${err}`)
  }
  process.exit(0)
}

void main()
