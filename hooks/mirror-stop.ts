#!/usr/bin/env bun
// Stop-hook: fires when Claude finishes a turn in a terminal-origin session.
// Reads the transcript_path passed on stdin, extracts the last assistant
// message text, and sends a `hook_post` frame to the daemon via the Unix
// socket. Daemon routes the post into the feishu thread bound to this
// claude session (by session UUID, falling back to cwd).
//
// stdin payload (from Claude Code) looks like:
//   {
//     "session_id": "<claude-session-uuid>",
//     "transcript_path": "/…/projects/<slug>/<uuid>.jsonl",
//     "cwd": "/…",
//     "hook_event_name": "Stop"
//   }
//
// We deliberately fail silently (never block Claude) — if the daemon is
// down or the socket is missing, we log to stderr and exit 0.

import { readFileSync } from "fs"
import { connect } from "net"
import { homedir } from "os"
import { join } from "path"

async function main(): Promise<void> {
  const debugLog = (m: string): void => {
    // Append to a local debug log since Stop-hook stderr goes to Claude's
    // process (invisible to us). Tail `${stateDir}/hook-debug.log` to trace.
    try {
      require("fs").appendFileSync(
        join(STATE_DIR_DEFAULT, "hook-debug.log"),
        `[${new Date().toISOString()}] ${m}\n`,
      )
    } catch {}
  }
  const raw = readFileSync(0, "utf8")  // stdin
  debugLog(`hook fired, stdin=${raw.length} bytes`)
  let payload: {
    session_id?: string
    transcript_path?: string
    cwd?: string
    hook_event_name?: string
  }
  try { payload = JSON.parse(raw) } catch {
    debugLog(`bad hook stdin payload`)
    process.exit(0)
  }

  if (!payload.transcript_path || !payload.cwd) {
    debugLog(`missing transcript_path/cwd`)
    process.exit(0)
  }

  // Stop-hook fires BEFORE Claude flushes the final text block of this turn
  // to the jsonl (observed on claude 2.1.117 in --print mode): the hook saw
  // text from the PREVIOUS turn, not the one that just completed. Wait for
  // the transcript to grow past its current event count before extracting,
  // with a short ceiling so we never block Claude's exit for long.
  const text = await waitForFreshAssistantText(payload.transcript_path, 2000)
  debugLog(`session=${payload.session_id ?? "?"} cwd=${payload.cwd} text_len=${text.length}`)
  if (!text) {
    debugLog(`no assistant text to mirror`)
    process.exit(0)
  }

  // Skip tiny / trivia turns so the feishu thread stays readable. Tune if
  // this threshold trims something useful.
  if (text.length < 8) {
    debugLog(`text too short (${text.length}), skipping`)
    return
  }

  const sock = process.env.FEISHU_DAEMON_SOCKET ?? join(STATE_DIR_DEFAULT, "daemon.sock")

  try {
    await sendHookPost(sock, {
      claude_session_uuid: payload.session_id ?? "",
      cwd: payload.cwd,
      text,
    })
    debugLog(`posted to daemon ok`)
  } catch (err) {
    debugLog(`daemon post failed: ${err}`)
  }
}

const STATE_DIR_DEFAULT = process.env.FEISHU_STATE_DIR ?? join(homedir(), ".claude", "channels", "feishu")

// Poll the transcript for up to maxMs until it holds at least one more
// assistant-text event than it did at call time, then return the latest
// text. If the count never grows (quiet turn with no final text), return
// whatever is there now. Guards against the Stop-hook-fires-before-flush
// race described in mirror-stop.ts.
export async function waitForFreshAssistantText(
  path: string, maxMs: number, readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<string> {
  const baseline = countAssistantTextEvents(path, readFile)
  const deadline = Date.now() + maxMs
  let last = ""
  while (Date.now() < deadline) {
    const now = countAssistantTextEvents(path, readFile)
    if (now > baseline) {
      return extractLastAssistantTextFromContent(readFile(path))
    }
    last = extractLastAssistantTextFromContent(readFile(path))
    await new Promise((r) => setTimeout(r, 120))
  }
  return last
}

function countAssistantTextEvents(path: string, readFile: (p: string) => string): number {
  try {
    let n = 0
    for (const line of readFile(path).split("\n")) {
      if (!line) continue
      let obj: any
      try { obj = JSON.parse(line) } catch { continue }
      const msg = obj?.message
      if (!msg || msg.role !== "assistant") continue
      if ((msg.content ?? []).some((c: any) => c?.type === "text" && (c.text ?? "").trim())) n++
    }
    return n
  } catch { return 0 }
}

function extractLastAssistantTextFromContent(content: string): string {
  const lines = content.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    const msg = obj?.message
    if (!msg || msg.role !== "assistant") continue
    const textPieces: string[] = []
    for (const c of msg.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        textPieces.push(c.text.trim())
      }
    }
    if (textPieces.length > 0) return textPieces.join("\n\n")
  }
  return ""
}

// Each line in the transcript is a JSON event. Walk backward and take the
// last assistant message's text content. Multi-block assistant messages
// (tool_use + text) concatenate all text blocks; tool-only turns are skipped.
export function extractLastAssistantText(path: string): string {
  const lines = readFileSync(path, "utf8").split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    const msg = obj?.message
    if (!msg || msg.role !== "assistant") continue
    const textPieces: string[] = []
    for (const c of msg.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        textPieces.push(c.text.trim())
      }
    }
    if (textPieces.length > 0) return textPieces.join("\n\n")
  }
  return ""
}

function sendHookPost(
  socketPath: string,
  body: { claude_session_uuid: string; cwd: string; text: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath)
    let settled = false
    const done = () => { if (settled) return; settled = true; try { s.end() } catch {}; resolve() }
    s.on("connect", () => {
      const frame = JSON.stringify({ id: 1, op: "hook_post", ...body }) + "\n"
      s.write(frame)
    })
    // Resolve on any bytes back from daemon (the ack) — we don't parse it.
    s.on("data", () => done())
    s.on("error", reject)
    // Belt-and-suspenders timeout so hook doesn't stall Claude's exit.
    setTimeout(done, 2000)
  })
}

if (import.meta.main) {
  await main()
}
