// Shared helpers for Claude Code hook scripts — socket send, debug log,
// and stdin parsing.
//
// The scripts are invoked as standalone Bun processes per Claude turn, so
// keeping them self-contained (no external deps beyond node:net/fs/path)
// means hook cold-start stays under ~100ms.

import { connect } from "net"
import { appendFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), ".claude", "channels", "feishu")
export const SOCKET = process.env.FEISHU_DAEMON_SOCKET ?? join(STATE_DIR, "daemon.sock")

export function debugLog(tag: string, message: string): void {
  try {
    appendFileSync(
      join(STATE_DIR, "hook-debug.log"),
      `[${new Date().toISOString()}] [${tag}] ${message}\n`,
    )
  } catch { /* best-effort */ }
}

// Fire-and-forget frame send to daemon. Resolves on any response byte (which
// implies daemon has processed the frame) or after a 2s ceiling so hook
// scripts never block Claude's exit.
export function sendFrame(body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(SOCKET)
    let settled = false
    const done = () => { if (settled) return; settled = true; try { s.end() } catch {}; resolve() }
    s.on("connect", () => {
      s.write(JSON.stringify({ id: 1, ...body }) + "\n")
    })
    s.on("data", () => done())
    s.on("error", reject)
    setTimeout(done, 2000)
  })
}
