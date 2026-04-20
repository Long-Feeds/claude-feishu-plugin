import { createServer, Server, Socket } from "net"
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { ulid } from "ulid"
import { DaemonState } from "./daemon-state"
import { NdjsonParser, frame, type ShimReq, type DaemonMsg } from "./ipc"
import type { FeishuApi } from "./feishu-api"
import { gate, type FeishuEvent } from "./gate"
import { loadAccess } from "./access"
import { loadThreads, findByThreadId, type ThreadStore } from "./threads"

export type DaemonConfig = {
  stateDir: string
  socketPath: string
  feishuApi: FeishuApi | null
  wsStart: () => Promise<void>
}

export class Daemon {
  private server: Server
  private state = new DaemonState()
  private pidFile: string
  private accessFile: string
  private threadsFile: string
  private threads: ThreadStore

  private constructor(private cfg: DaemonConfig) {
    this.pidFile = join(cfg.stateDir, "daemon.pid")
    this.accessFile = join(cfg.stateDir, "access.json")
    this.threadsFile = join(cfg.stateDir, "threads.json")
    this.threads = loadThreads(this.threadsFile)
    this.server = createServer((conn) => this.onConn(conn))
  }

  static async start(cfg: DaemonConfig): Promise<Daemon> {
    const d = new Daemon(cfg)
    d.claimPidFile()
    await d.bindSocket()
    await cfg.wsStart()
    return d
  }

  private claimPidFile(): void {
    if (existsSync(this.pidFile)) {
      const oldPid = Number(readFileSync(this.pidFile, "utf8").trim())
      if (oldPid && this.pidAlive(oldPid)) {
        throw new Error(`daemon already running as pid ${oldPid}`)
      }
      try { unlinkSync(this.pidFile) } catch {}
    }
    writeFileSync(this.pidFile, String(process.pid), { mode: 0o600 })
  }

  private pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  private async bindSocket(): Promise<void> {
    if (existsSync(this.cfg.socketPath)) {
      try { unlinkSync(this.cfg.socketPath) } catch {}
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(this.cfg.socketPath, () => {
        try { chmodSync(this.cfg.socketPath, 0o600) } catch {}
        this.server.off("error", reject)
        resolve()
      })
    })
  }

  private onConn(conn: Socket): void {
    const parser = new NdjsonParser()
    conn.on("data", (buf: Buffer) => {
      parser.feed(buf.toString("utf8"), (msg) => this.onMessage(conn, msg as ShimReq))
    })
    conn.on("close", () => this.onClose(conn))
    conn.on("error", () => { try { conn.destroy() } catch {} })
  }

  protected onMessage(conn: Socket, msg: ShimReq): void {
    switch (msg.op) {
      case "register": return this.handleRegister(conn, msg)
      default:
        try {
          conn.write(frame({ id: (msg as any).id, ok: false, error: `unknown op: ${(msg as any).op}` }))
        } catch {}
    }
  }

  private handleRegister(conn: Socket, msg: Extract<ShimReq, { op: "register" }>): void {
    const session_id = msg.session_id ?? ulid()
    this.state.register({
      session_id, conn, cwd: msg.cwd, pid: msg.pid, registered_at: Date.now(),
    })
    try {
      conn.write(frame({ id: msg.id, ok: true, session_id, thread_id: null }))
    } catch {}
  }

  protected onClose(conn: Socket): void {
    const entry = this.state.findByConn(conn)
    if (!entry) return
    this.state.remove(entry.session_id)
  }

  async deliverFeishuEvent(event: FeishuEvent, botOpenId: string): Promise<void> {
    const access = loadAccess(this.accessFile)
    const decision = gate(event, access, botOpenId)
    if (decision.action === "drop") return
    if (decision.action === "pair") {
      // Task 10 fills in pair-reply; skip here.
      return
    }
    const thread_id = event.message.thread_id
    if (thread_id) {
      const rec = findByThreadId(this.threads, thread_id)
      if (!rec) return
      const entry = this.state.get(rec.session_id)
      if (!entry) {
        // inactive — Task 11 adds L2 resume.
        return
      }
      try {
        entry.conn.write(frame({
          push: "inbound",
          content: extractText(event),
          meta: {
            chat_id: event.message.chat_id,
            message_id: event.message.message_id,
            thread_id,
            user: event.sender.sender_id?.open_id ?? "",
            user_id: event.sender.sender_id?.open_id ?? "",
            ts: new Date(Number(event.message.create_time)).toISOString(),
          },
        }))
      } catch {}
      return
    }
    // Top-level message (no thread) — Task 10/11 spawn new session.
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    try { unlinkSync(this.cfg.socketPath) } catch {}
    try { unlinkSync(this.pidFile) } catch {}
  }
}

function extractText(event: FeishuEvent): string {
  try { return JSON.parse(event.message.content).text ?? "" } catch { return "" }
}

if (import.meta.main) {
  process.stderr.write("daemon entrypoint: full init deferred to Task 12\n")
  process.exit(0)
}
