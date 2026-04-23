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

export class DaemonState {
  private sessions = new Map<string, SessionEntry>()

  register(entry: SessionEntry): SessionEntry | null {
    const prev = this.sessions.get(entry.session_id)
    if (prev && prev.conn !== entry.conn) {
      try { prev.conn.destroy() } catch {}
    }
    this.sessions.set(entry.session_id, entry)
    return prev ?? null
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
