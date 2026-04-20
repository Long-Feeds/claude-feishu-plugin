import type { Socket } from "net"

export type SessionEntry = {
  session_id: string
  conn: Socket
  cwd: string
  pid: number
  registered_at: number
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
}
