import type { Socket } from "net"

export type SessionEntry = {
  session_id: string
  conn: Socket
  cwd: string
  pid: number
  registered_at: number
  // tmux window the shim's claude is running inside (e.g. "fb:gzaj6ax7").
  // Reported by the shim from $TMUX_PANE at register time. Required for
  // routing feishu inbound back to the right pane via tmux send-keys.
  // Survives daemon restart because shim re-registers on reconnect.
  tmux_window_name?: string
}

export type RegisterResult =
  | { ok: true; prev: SessionEntry | null }
  | { ok: false; reason: "duplicate-live-pid"; prev: SessionEntry }

export class DaemonState {
  private sessions = new Map<string, SessionEntry>()

  register(entry: SessionEntry): RegisterResult {
    const prev = this.sessions.get(entry.session_id)
    if (prev && prev.conn !== entry.conn) {
      // A different process is already registered under this session_id.
      // Historically we destroyed prev.conn unconditionally so a shim that
      // restarted (same pid, new socket) could re-register cleanly. The
      // problem: when TWO live shims collide on the same session_id (from
      // a UUID-probe race), destroying the other's conn just triggers an
      // infinite destroy-reconnect storm that burns CPU and — because it
      // keeps firing handleRegister — can hijack unrelated spawnIntents
      // keyed by cwd. Refuse the newcomer in that case; shim caller is
      // expected to exit rather than keep retrying.
      if (prev.pid !== entry.pid && !prev.conn.destroyed) {
        return { ok: false, reason: "duplicate-live-pid", prev }
      }
      try { prev.conn.destroy() } catch {}
    }
    this.sessions.set(entry.session_id, entry)
    return { ok: true, prev: prev ?? null }
  }

  get(session_id: string): SessionEntry | undefined {
    return this.sessions.get(session_id)
  }

  remove(session_id: string): void {
    this.sessions.delete(session_id)
  }

  findByConn(conn: Socket): SessionEntry | undefined {
    for (const s of this.sessions.values()) if (s.conn === conn) return s
    return undefined
  }

  all(): SessionEntry[] {
    return [...this.sessions.values()]
  }

  // Find the most-recently-registered live session for a cwd. Used by the
  // UserPromptSubmit hook path, where the hook carries the Claude session
  // UUID but the shim may have registered under a ULID (jsonl probe timed
  // out). Matching by cwd bridges that gap.
  findNewestTerminalForCwd(cwd: string): SessionEntry | undefined {
    let best: SessionEntry | undefined
    for (const s of this.sessions.values()) {
      if (s.cwd !== cwd) continue
      if (!best || s.registered_at > best.registered_at) best = s
    }
    return best
  }
}
