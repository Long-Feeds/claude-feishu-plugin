import { createServer, Server, Socket } from "net"
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { ulid } from "ulid"
import { DaemonState } from "./daemon-state"
import { NdjsonParser, frame, type ShimReq, type DaemonMsg } from "./ipc"
import type { ReplyReq } from "./ipc"
import type { FeishuApi } from "./feishu-api"
import { gate, type FeishuEvent } from "./gate"
import { loadAccess } from "./access"
import { loadThreads, saveThreads, upsertThread, findByThreadId, findBySessionId, type ThreadStore, type ThreadRecord } from "./threads"
import { buildSpawnCommand, ensureTmuxSession } from "./spawn"

export type DaemonConfig = {
  stateDir: string
  socketPath: string
  feishuApi: FeishuApi | null
  wsStart: () => Promise<void>
  tmuxSession?: string
  defaultCwd?: string
  spawnOverride?: (argv: string[], env: Record<string, string>) => Promise<number>
}

export class Daemon {
  private server: Server
  private state = new DaemonState()
  private pidFile: string
  private accessFile: string
  private threadsFile: string
  private threads: ThreadStore
  private pendingRoots = new Map<string, { chat_id: string; root_message_id: string }>()
  private pendingYbRoots = new Map<string, { chat_id: string; root_message_id: string }>()

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
      case "reply": return void this.handleReply(conn, msg as ReplyReq)
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

  private async handleReply(conn: Socket, msg: ReplyReq): Promise<void> {
    if (!this.cfg.feishuApi) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "feishu api not configured" })) } catch {}
      return
    }
    const entry = this.state.findByConn(conn)
    if (!entry) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "session not registered" })) } catch {}
      return
    }
    const format = msg.format ?? "text"
    const bound = findBySessionId(this.threads, entry.session_id)
    const pending = this.pendingRoots.get(entry.session_id)
    const ybRoot = this.pendingYbRoots.get(entry.session_id)

    try {
      if (!bound && !pending && ybRoot) {
        // First reply for Y-b: seed thread rooted on the user's triggering message.
        const res = await this.cfg.feishuApi.sendInThread({
          root_message_id: ybRoot.root_message_id, text: msg.text, format, seed_thread: true,
        })
        if (!res.thread_id) {
          conn.write(frame({ id: msg.id, ok: false, error: "Y-b thread creation returned no thread_id" }))
          return
        }
        upsertThread(this.threads, res.thread_id, {
          session_id: entry.session_id, chat_id: ybRoot.chat_id,
          root_message_id: ybRoot.root_message_id, cwd: entry.cwd,
          origin: "Y-b", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
        })
        saveThreads(this.threadsFile, this.threads)
        this.pendingYbRoots.delete(entry.session_id)
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: res.thread_id }))
        return
      }
      if (!bound && !pending) {
        // First reply for X-b: plain create in hub.
        const access = loadAccess(this.accessFile)
        const chat_home = access.hubChatId
        if (!chat_home) {
          conn.write(frame({ id: msg.id, ok: false, error: "no Feishu hub chat configured — DM the bot first" }))
          return
        }
        const res = await this.cfg.feishuApi.sendRoot({ chat_id: chat_home, text: msg.text, format })
        this.pendingRoots.set(entry.session_id, { chat_id: chat_home, root_message_id: res.message_id })
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: null }))
        return
      }
      if (!bound && pending) {
        // Second reply: seed thread via reply_in_thread=true on pending root.
        const res = await this.cfg.feishuApi.sendInThread({
          root_message_id: pending.root_message_id, text: msg.text, format, seed_thread: true,
        })
        if (!res.thread_id) {
          conn.write(frame({ id: msg.id, ok: false, error: "thread creation returned no thread_id" }))
          return
        }
        upsertThread(this.threads, res.thread_id, {
          session_id: entry.session_id, chat_id: pending.chat_id,
          root_message_id: pending.root_message_id, cwd: entry.cwd,
          origin: "X-b", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
        })
        saveThreads(this.threadsFile, this.threads)
        this.pendingRoots.delete(entry.session_id)
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: res.thread_id }))
        return
      }
      if (bound) {
        if (bound.status === "closed") {
          conn.write(frame({ id: msg.id, ok: false, error: "thread closed" }))
          return
        }
        const res = await this.cfg.feishuApi.sendInThread({
          root_message_id: bound.root_message_id, text: msg.text, format, seed_thread: false,
        })
        this.threads.threads[bound.thread_id]!.last_message_at = Date.now()
        saveThreads(this.threadsFile, this.threads)
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: bound.thread_id }))
        return
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      try { conn.write(frame({ id: msg.id, ok: false, error: m })) } catch {}
    }
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
      await this.sendPairReply(event, decision.code, decision.isResend)
      return
    }
    const thread_id = event.message.thread_id
    if (thread_id) {
      const rec = findByThreadId(this.threads, thread_id)
      if (!rec) return
      if (rec.status === "closed") {
        if (this.cfg.feishuApi) {
          await this.cfg.feishuApi.sendInThread({
            root_message_id: rec.root_message_id,
            text: "thread closed — send a new top-level message for a new session",
            format: "text", seed_thread: false,
          }).catch(() => {})
        }
        return
      }
      const entry = this.state.get(rec.session_id)
      if (entry) {
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
      // Inactive → L2 resume.
      await this.resumeSession(rec, thread_id, event)
      return
    }
    await this.spawnYb(event)
  }

  private async sendPairReply(event: FeishuEvent, code: string, isResend: boolean): Promise<void> {
    if (!this.cfg.feishuApi) return
    const lead = isResend ? "Still pending" : "Pairing required"
    await this.cfg.feishuApi.sendRoot({
      chat_id: event.message.chat_id,
      text: `${lead} — run in Claude Code:\n\n/feishu:access pair ${code}`,
      format: "text",
    }).catch((e) => { process.stderr.write(`daemon: pair reply failed: ${e}\n`) })
  }

  private async spawnYb(event: FeishuEvent): Promise<void> {
    const tmux = this.cfg.tmuxSession ?? "claude-feishu"
    const cwd = this.cfg.defaultCwd ?? process.env.FEISHU_DEFAULT_CWD ?? `${process.env.HOME}/workspace`
    const session_id = ulid()
    let prompt = ""
    try { prompt = JSON.parse(event.message.content).text ?? "" } catch {}

    this.pendingYbRoots.set(session_id, {
      chat_id: event.message.chat_id,
      root_message_id: event.message.message_id,
    })

    if (!this.cfg.spawnOverride) await ensureTmuxSession(tmux)
    const cmd = buildSpawnCommand({
      session_id, cwd, initial_prompt: prompt, tmux_session: tmux, kind: "Y-b",
    })
    if (this.cfg.spawnOverride) {
      await this.cfg.spawnOverride(cmd.argv, cmd.env)
    } else {
      const { spawn } = await import("child_process")
      spawn(cmd.argv[0]!, cmd.argv.slice(1), { stdio: "ignore", detached: true }).unref()
    }
  }

  private async resumeSession(rec: ThreadRecord, thread_id: string, event: FeishuEvent): Promise<void> {
    const tmux = this.cfg.tmuxSession ?? "claude-feishu"
    const { existsSync } = await import("fs")
    if (!existsSync(rec.cwd)) {
      if (this.cfg.feishuApi) {
        await this.cfg.feishuApi.sendInThread({
          root_message_id: rec.root_message_id,
          text: `cwd \`${rec.cwd}\` no longer exists; archiving this thread`,
          format: "text", seed_thread: false,
        }).catch(() => {})
      }
      this.threads.threads[thread_id]!.status = "closed"
      saveThreads(this.threadsFile, this.threads)
      return
    }
    let prompt = ""
    try { prompt = JSON.parse(event.message.content).text ?? "" } catch {}
    const cmd = buildSpawnCommand({
      session_id: rec.session_id, cwd: rec.cwd, initial_prompt: prompt,
      tmux_session: tmux, kind: "resume",
      claude_session_uuid: rec.claude_session_uuid,
    })
    if (this.cfg.spawnOverride) {
      await this.cfg.spawnOverride(cmd.argv, cmd.env)
    } else {
      await ensureTmuxSession(tmux)
      const { spawn } = await import("child_process")
      spawn(cmd.argv[0]!, cmd.argv.slice(1), { stdio: "ignore", detached: true }).unref()
    }
    this.threads.threads[thread_id]!.status = "active"
    this.threads.threads[thread_id]!.last_active_at = Date.now()
    saveThreads(this.threadsFile, this.threads)
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
