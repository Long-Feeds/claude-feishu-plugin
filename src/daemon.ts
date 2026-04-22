import { createServer, Server, Socket } from "net"
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { ulid } from "ulid"
import * as lark from "@larksuiteoapi/node-sdk"
import { DaemonState } from "./daemon-state"
import { NdjsonParser, frame, type ShimReq, type DaemonMsg } from "./ipc"
import type { ReplyReq } from "./ipc"
import type { ReactReq, EditReq, DownloadReq, PermissionReq, SessionInfoReq } from "./ipc"
import type { FeishuApi } from "./feishu-api"
import { gate, type FeishuEvent } from "./gate"
import { loadAccess, saveAccess } from "./access"
import { loadThreads, saveThreads, upsertThread, findByThreadId, findBySessionId, markActive, markInactive, pruneInactive, type ThreadStore, type ThreadRecord } from "./threads"
import { buildSpawnCommand, ensureTmuxSession } from "./spawn"
import { extractTextAndAttachment } from "./inbound"

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// Emoji reactions we apply to inbound messages to give the sender a fast
// non-verbal ack. Empty string = disabled. emoji_type is CASE-SENSITIVE —
// unknown names return code 231001. Authoritative list:
// docs/feishu-emoji-types.md (mirror of Feishu's server-docs emoji enum).
//   doing   — "received, routing to a session" (before Claude has replied)
//   closed  — "thread is archived, won't process"
// `OnIt` = "我正在处理" is the cleanest semantic match for doing; `CrossMark`
// (❌) for a closed thread is much clearer than any crying face.
// We deliberately don't react on drop/pair: drop is silent by design, and
// pair already gets a visible text response carrying the pairing code.
const REACT_DOING = process.env.FEISHU_REACT_DOING ?? "OnIt"
const REACT_CLOSED = process.env.FEISHU_REACT_CLOSED ?? "CrossMark"

export type SendKeysMeta = {
  chat_id?: string; thread_id?: string; message_id?: string;
  user?: string; ts?: string;
  // Attachment passthroughs — the shim's MCP instructions tell Claude to Read
  // image_path when present and to call download_attachment on file_key.
  // Dropping these tags here silently breaks image/file inbound on feishu-spawned paths.
  image_path?: string;
  attachment_kind?: string;
  attachment_file_key?: string;
  attachment_name?: string;
}

// Encode a Feishu inbound event as a single-line <channel> tag safe to ship
// through `tmux send-keys -l`. Three constraints:
//   1. No literal \n in the typed text — tmux treats it as Enter, which would
//      submit a partial prompt and leave the tail typed into the next Claude
//      prompt. Collapse all vertical whitespace to spaces.
//   2. A malicious sender could embed `</channel>` inside their message to
//      prematurely close the tag and inject arbitrary content Claude would
//      process as user input. Escape that sequence defensively.
//   3. Attribute values may contain `"` (e.g. an attachment_name with quotes
//      in it). Escape them so they don't break the tag.
function attr(v: string): string { return v.replace(/"/g, "&quot;") }
export function wrapForSendKeys(meta: SendKeysMeta, content: string): string {
  const tags = [
    `source="feishu"`,
    meta.chat_id && `chat_id="${attr(meta.chat_id)}"`,
    meta.thread_id && `thread_id="${attr(meta.thread_id)}"`,
    meta.message_id && `message_id="${attr(meta.message_id)}"`,
    meta.user && `user="${attr(meta.user)}"`,
    meta.ts && `ts="${attr(meta.ts)}"`,
    meta.image_path && `image_path="${attr(meta.image_path)}"`,
    meta.attachment_kind && `attachment_kind="${attr(meta.attachment_kind)}"`,
    meta.attachment_file_key && `attachment_file_key="${attr(meta.attachment_file_key)}"`,
    meta.attachment_name && `attachment_name="${attr(meta.attachment_name)}"`,
  ].filter(Boolean).join(" ")
  const flattened = content
    .replace(/<\/channel>/gi, "</ channel>")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return `<channel ${tags}>${flattened}</channel>`
}

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
  private pendingFeishuRoots = new Map<string, { chat_id: string; root_message_id: string }>()
  // Terminal-origin sessions that registered while hubChatId was unset —
  // announce them once the first delivered inbound auto-populates the hub.
  private deferredTerminalAnnounce = new Map<string, { cwd: string }>()

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
    // At boot, nothing is connected yet — any "active" in threads.json is a
    // lingering value from the previous daemon lifetime. Sweep to inactive;
    // shims that reconnect will flip themselves back via handleRegister.
    let changed = false
    for (const [tid, rec] of Object.entries(d.threads.threads)) {
      if (rec.status === "active") {
        d.threads.threads[tid]!.status = "inactive"
        changed = true
      }
    }
    // Drop inactive entries older than TTL (default 30d). Keeps threads.json
    // bounded — otherwise every auto-spawn adds a row that never goes away.
    // Active / closed records are preserved: closed is an explicit user intent,
    // and active is currently in use.
    const ttlDays = Number(process.env.FEISHU_THREADS_TTL_DAYS ?? "30")
    const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400_000 : 30 * 86400_000
    const pruned = pruneInactive(d.threads, ttlMs)
    if (pruned.length > 0) {
      process.stderr.write(`daemon: pruned ${pruned.length} inactive thread(s) older than ${ttlDays}d\n`)
      changed = true
    }
    if (changed) saveThreads(d.threadsFile, d.threads)
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
      case "react": return void this.handleReact(conn, msg as ReactReq)
      case "edit_message": return void this.handleEdit(conn, msg as EditReq)
      case "download_attachment": return void this.handleDownload(conn, msg as DownloadReq)
      case "permission_request": return void this.handlePermissionRequest(conn, msg as PermissionReq)
      case "session_info": return void this.handleSessionInfo(conn, msg as SessionInfoReq)
      default:
        try {
          conn.write(frame({ id: (msg as any).id, ok: false, error: `unknown op: ${(msg as any).op}` }))
        } catch {}
    }
  }

  private handleRegister(conn: Socket, msg: Extract<ShimReq, { op: "register" }>): void {
    const isFreshRegistration = msg.session_id === null || msg.session_id === undefined
    const session_id = msg.session_id ?? ulid()
    this.state.register({
      session_id, conn, cwd: msg.cwd, pid: msg.pid, registered_at: Date.now(),
    })
    // If the session already has a thread binding, flip status back to active
    // (e.g. shim reconnecting after daemon restart).
    if (findBySessionId(this.threads, session_id)) {
      markActive(this.threads, session_id)
      saveThreads(this.threadsFile, this.threads)
    }
    try {
      conn.write(frame({ id: msg.id, ok: true, session_id, thread_id: null }))
    } catch {}

    // Terminal auto-announce: a fresh terminal `claude` invocation loads the
    // plugin, shim registers with session_id=null, daemon assigns a ULID — but
    // nothing was previously visible on Feishu, so the user couldn't tell the
    // bridge was live or know which thread to reply in. Post a root "online"
    // message to the hub and prime pendingRoots so the session's first MCP
    // reply seeds a thread off that announce (instead of creating a second
    // root). We skip:
    //   - feishu-spawned sessions (pendingFeishuInbound carries their trigger),
    //   - reconnects (msg.session_id set → isFreshRegistration=false),
    //   - sessions that already own a thread (resume revival path).
    const isFeishuSpawn = this.pendingFeishuInbound.has(session_id)
    const alreadyBound = !!findBySessionId(this.threads, session_id)
    const alreadyPending = this.pendingRoots.has(session_id)
    if (
      isFreshRegistration && !isFeishuSpawn && !alreadyBound && !alreadyPending &&
      this.cfg.feishuApi
    ) {
      const hub = loadAccess(this.accessFile).hubChatId
      if (hub) {
        this.sendTerminalAnnounce(session_id, hub, msg.cwd)
      } else {
        this.deferredTerminalAnnounce.set(session_id, { cwd: msg.cwd })
        process.stderr.write(`daemon: terminal session=${session_id} registered but hubChatId unset — deferred; first inbound will auto-populate + announce\n`)
      }
    }
    // Inject the triggering message into the spawned tmux pane as typed user
    // input. Claude Code's welcome screen swallows MCP channel notifications
    // sent before first interaction, so pushing through the socket (the normal
    // path used for mid-session inbound messages) does nothing at startup.
    // `tmux send-keys` simulates the user typing the prompt into the terminal,
    // which reliably kicks Claude off the welcome screen AND triggers auto-
    // processing. The 5s delay gives Claude time to finish booting past the
    // welcome splash. The content is wrapped in the same <channel source="feishu">
    // tag Claude Code normally renders for channel notifications, so Claude
    // knows the chat_id/thread_id etc. when it calls the reply tool.
    // Fires only once per session; reconnect of the same session_id finds no
    // entry and no-ops.
    const pending = this.pendingFeishuInbound.get(session_id)
    if (pending) {
      this.pendingFeishuInbound.delete(session_id)
      const m = pending.meta as SendKeysMeta
      const wrapped = wrapForSendKeys(m, pending.content)
      const tmuxSession = this.cfg.tmuxSession ?? "claude-feishu"
      const windowName = `fb:${session_id.slice(0, 8)}`
      setTimeout(async () => {
        try {
          const { spawn } = await import("child_process")
          const target = `${tmuxSession}:${windowName}`
          // Use -l (literal) for the text payload so tmux doesn't interpret
          // any char (like $, backticks) as a keybinding. Then split off Enter
          // into a second send-keys call with a short gap — Claude Code's
          // input reader drops the Enter if it arrives in the same burst as
          // the tail of the text.
          spawn("tmux", ["send-keys", "-t", target, "-l", wrapped], { stdio: "ignore" }).unref()
          setTimeout(() => {
            spawn("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" }).unref()
          }, 300)
          process.stderr.write(`daemon: injected feishu-spawn initial into tmux window ${windowName}\n`)
        } catch (err) {
          process.stderr.write(`daemon: feishu-spawn tmux send-keys failed: ${err}\n`)
        }
      }, 5000)
    }
  }

  private sendTerminalAnnounce(session_id: string, hub: string, cwd: string): void {
    if (!this.cfg.feishuApi) return
    this.cfg.feishuApi.sendRoot({
      chat_id: hub,
      text: `🟢 Claude Code session online\ncwd: ${cwd}`,
      format: "text",
    }).then((res) => {
      // Prime pendingRoots so the session's first MCP reply seeds a thread
      // off this announce rather than creating a second root message.
      this.pendingRoots.set(session_id, { chat_id: hub, root_message_id: res.message_id })
      process.stderr.write(`daemon: terminal auto-announce session=${session_id} hub=${hub} msg=${res.message_id}\n`)
      // Push a hint inbound to the shim so Claude knows it's bridged and
      // which chat_id to post updates to. Without this hint, terminal
      // Claude has no idea the session should mirror progress to Feishu —
      // the default MCP instructions are written for the feishu-spawn case
      // ("sender reads Feishu, not this session"), which is literally wrong
      // for terminal-origin where the user IS at the terminal. The hint
      // gets routed through the existing push:inbound → shim → MCP channel
      // notification path, so Claude processes it exactly like any other
      // <channel> message and picks up chat_id for subsequent reply calls.
      const entry = this.state.get(session_id)
      if (entry) {
        try {
          entry.conn.write(frame({
            push: "inbound",
            content:
              "Bridge hint (terminal session): this Claude is bridged to a Feishu group. " +
              "The operator may or may not be watching the terminal — post concise " +
              "progress updates via the `reply` tool with the chat_id below so remote " +
              "observers can follow. You don't need to reply every line — key milestones " +
              "and final results are enough.",
            meta: {
              chat_id: hub,
              initial: "true",
              source: "feishu-bridge-hint",
            },
          }))
        } catch {}
      }
    }).catch((e) => process.stderr.write(`daemon: terminal auto-announce failed: ${e}\n`))
  }

  private announceDeferredTerminalSessions(hub: string): void {
    if (this.deferredTerminalAnnounce.size === 0) return
    for (const [session_id, info] of this.deferredTerminalAnnounce) {
      this.sendTerminalAnnounce(session_id, hub, info.cwd)
    }
    this.deferredTerminalAnnounce.clear()
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
    const feishuRoot = this.pendingFeishuRoots.get(entry.session_id)

    try {
      if (!bound && !pending && feishuRoot) {
        // First reply for feishu-spawned: seed thread rooted on the user's triggering message.
        const res = await this.cfg.feishuApi.sendInThread({
          root_message_id: feishuRoot.root_message_id, text: msg.text, format, seed_thread: true,
        })
        if (!res.thread_id) {
          conn.write(frame({ id: msg.id, ok: false, error: "feishu-spawn thread creation returned no thread_id" }))
          return
        }
        upsertThread(this.threads, res.thread_id, {
          session_id: entry.session_id, chat_id: feishuRoot.chat_id,
          root_message_id: feishuRoot.root_message_id, cwd: entry.cwd,
          origin: "feishu", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
        })
        saveThreads(this.threadsFile, this.threads)
        this.pendingFeishuRoots.delete(entry.session_id)
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: res.thread_id }))
        return
      }
      if (!bound && !pending) {
        // First reply for terminal: plain create in hub.
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
          origin: "terminal", status: "active",
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

  private async handleReact(conn: Socket, msg: ReactReq): Promise<void> {
    if (!this.cfg.feishuApi) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "feishu api not configured" })) } catch {}
      return
    }
    try {
      await this.cfg.feishuApi.reactTo(msg.message_id, msg.emoji_type)
      conn.write(frame({ id: msg.id, ok: true }))
    } catch (err) {
      try { conn.write(frame({ id: msg.id, ok: false, error: (err as Error).message })) } catch {}
    }
  }

  private async handleEdit(conn: Socket, msg: EditReq): Promise<void> {
    if (!this.cfg.feishuApi) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "feishu api not configured" })) } catch {}
      return
    }
    try {
      await this.cfg.feishuApi.edit({ message_id: msg.message_id, text: msg.text, format: msg.format ?? "text" })
      conn.write(frame({ id: msg.id, ok: true }))
    } catch (err) {
      try { conn.write(frame({ id: msg.id, ok: false, error: (err as Error).message })) } catch {}
    }
  }

  private async handleDownload(conn: Socket, msg: DownloadReq): Promise<void> {
    if (!this.cfg.feishuApi) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "feishu api not configured" })) } catch {}
      return
    }
    try {
      const { mkdirSync } = await import("fs")
      const inboxDir = join(this.cfg.stateDir, "inbox")
      mkdirSync(inboxDir, { recursive: true })
      const ext = msg.type === "image" ? "png" : "bin"
      const dest = join(inboxDir, `${Date.now()}-${msg.file_key.slice(0, 16)}.${ext}`)
      await this.cfg.feishuApi.downloadResource({
        message_id: msg.message_id, file_key: msg.file_key, type: msg.type, dest_path: dest,
      })
      conn.write(frame({ id: msg.id, ok: true, path: dest }))
    } catch (err) {
      try { conn.write(frame({ id: msg.id, ok: false, error: (err as Error).message })) } catch {}
    }
  }

  private async handlePermissionRequest(conn: Socket, msg: PermissionReq): Promise<void> {
    const entry = this.state.findByConn(conn)
    if (!entry) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "no session" })) } catch {}
      return
    }
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(msg.input_preview), null, 2) } catch { prettyInput = msg.input_preview }
    const text =
      `🔐 Permission: ${msg.tool_name}\n\n` +
      `Description: ${msg.description}\nInput:\n${prettyInput}\n\n` +
      `Reply with: y ${msg.request_id} to allow, n ${msg.request_id} to deny`
    if (this.cfg.feishuApi) {
      const bound = findBySessionId(this.threads, entry.session_id)
      if (bound) {
        this.cfg.feishuApi.sendInThread({
          root_message_id: bound.root_message_id, text, format: "text", seed_thread: false,
        }).catch((e) => { process.stderr.write(`daemon: permission relay (in-thread) failed: ${e}\n`) })
      } else {
        const hub = loadAccess(this.accessFile).hubChatId
        if (hub) {
          this.cfg.feishuApi.sendRoot({ chat_id: hub, text, format: "text" })
            .catch((e) => { process.stderr.write(`daemon: permission relay (hub) failed: ${e}\n`) })
        }
      }
    }
    try { conn.write(frame({ id: msg.id, ok: true })) } catch {}
  }

  private handleSessionInfo(conn: Socket, msg: SessionInfoReq): void {
    const entry = this.state.findByConn(conn)
    if (!entry) return
    const bound = findBySessionId(this.threads, entry.session_id)
    if (bound) {
      this.threads.threads[bound.thread_id]!.claude_session_uuid = msg.claude_session_uuid
      saveThreads(this.threadsFile, this.threads)
    }
    try { conn.write(frame({ id: msg.id, ok: true })) } catch {}
  }

  protected onClose(conn: Socket): void {
    const entry = this.state.findByConn(conn)
    if (!entry) return
    this.state.remove(entry.session_id)
    // Reflect shim disconnect in persistent state so `/feishu:access threads`
    // and friends show realistic status. The thread stays — resume brings
    // it back up if the user replies into it later.
    if (findBySessionId(this.threads, entry.session_id)) {
      markInactive(this.threads, entry.session_id)
      saveThreads(this.threadsFile, this.threads)
    }
  }

  async deliverFeishuEvent(event: FeishuEvent, botOpenId: string): Promise<void> {
    const access = loadAccess(this.accessFile)
    const decision = gate(event, access, botOpenId)
    process.stderr.write(`daemon: gate decision: ${decision.action}\n`)
    if (decision.action === "drop") return
    if (decision.action === "pair") {
      // gate() mutated access.pending (issued or bumped replies) — persist it
      saveAccess(this.accessFile, access)
      await this.sendPairReply(event, decision.code, decision.isResend)
      return
    }
    // Auto-populate hubChatId on the first delivered inbound event when it's
    // still unset. Without this, terminal-session first-reply errors with
    // "no Feishu hub chat configured — DM the bot first", which is a silent
    // dead-end for users who start with group-only usage. Whichever chat
    // first gets routed becomes the hub; later inbounds don't overwrite.
    if (!access.hubChatId) {
      access.hubChatId = event.message.chat_id
      saveAccess(this.accessFile, access)
      process.stderr.write(`daemon: hubChatId auto-set to ${access.hubChatId}\n`)
      // Any terminal sessions that registered before hub existed deferred
      // their "session online" announce. Now that hub is known, fire them
      // so the user can see which terminal claudes are bridged.
      this.announceDeferredTerminalSessions(access.hubChatId)
    }
    // Fast non-verbal ack so the sender knows their message was picked up even
    // before Claude produces a reply (feishu-spawn can take multiple seconds).
    // Fire-and-forget: reaction failures (unsupported emoji_type, API hiccup)
    // must not stall routing.
    if (REACT_DOING && this.cfg.feishuApi) {
      this.cfg.feishuApi.reactTo(event.message.message_id, REACT_DOING)
        .catch((e) => { process.stderr.write(`daemon: react(doing) failed: ${e}\n`) })
    }
    const thread_id = event.message.thread_id
    if (thread_id) {
      const rec = findByThreadId(this.threads, thread_id)
      if (!rec) {
        // Unknown thread. In topic-mode groups, the *root* message of a new
        // topic already carries a thread_id (Feishu auto-threads). Treat as a
        // fresh feishu-spawn trigger and bind this thread_id to the new
        // session up-front.
        await this.spawnFeishu(event, thread_id)
        return
      }
      if (rec.status === "closed") {
        if (this.cfg.feishuApi) {
          if (REACT_CLOSED) {
            this.cfg.feishuApi.reactTo(event.message.message_id, REACT_CLOSED)
              .catch((e) => { process.stderr.write(`daemon: react(closed) failed: ${e}\n`) })
          }
          await this.cfg.feishuApi.sendInThread({
            root_message_id: rec.root_message_id,
            text: "thread closed — send a new top-level message for a new session",
            format: "text", seed_thread: false,
          }).catch(() => {})
        }
        return
      }
      const entry = this.state.get(rec.session_id)
      process.stderr.write(`daemon: thread ${thread_id} → session ${rec.session_id} → entry ${entry ? "FOUND" : "MISSING"}\n`)
      if (entry) {
        const { text, attachment } = extractTextAndAttachment(event)

        // Permission reply intercept
        const permMatch = PERMISSION_REPLY_RE.exec(text)
        if (permMatch) {
          try {
            entry.conn.write(frame({
              push: "permission_reply",
              request_id: permMatch[2]!.toLowerCase(),
              behavior: permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
            }))
          } catch {}
          if (this.cfg.feishuApi) {
            // Case-sensitive per Feishu API: THUMBSUP (all caps) vs ThumbsDown
            // (camel case). See docs/feishu-emoji-types.md.
            this.cfg.feishuApi.reactTo(
              event.message.message_id,
              permMatch[1]!.toLowerCase().startsWith("y") ? "THUMBSUP" : "ThumbsDown",
            ).catch(() => {})
          }
          return
        }

        // Download images eagerly so the send-keys payload can include an
        // image_path attribute Claude can Read immediately. If this fails,
        // keep going — attachment_file_key is still in the tag and Claude can
        // fall back to the download_attachment MCP tool.
        let imagePath: string | undefined
        if (event.message.message_type === "image" && this.cfg.feishuApi) {
          try {
            const { mkdirSync } = await import("fs")
            const inboxDir = join(this.cfg.stateDir, "inbox")
            mkdirSync(inboxDir, { recursive: true })
            const content = JSON.parse(event.message.content)
            const imageKey = content.image_key
            if (imageKey) {
              const dest = join(inboxDir, `${Date.now()}-${imageKey.slice(0, 16)}.png`)
              await this.cfg.feishuApi.downloadResource({
                message_id: event.message.message_id, file_key: imageKey,
                type: "image", dest_path: dest,
              })
              imagePath = dest
            }
          } catch (err) {
            process.stderr.write(`daemon: eager image download failed (Claude can still call download_attachment): ${err}\n`)
          }
        }
        const inboundMeta: Record<string, string> = {
          chat_id: event.message.chat_id,
          message_id: event.message.message_id,
          thread_id,
          user: event.sender.sender_id?.open_id ?? "",
          user_id: event.sender.sender_id?.open_id ?? "",
          ts: new Date(Number(event.message.create_time)).toISOString(),
        }
        if (imagePath) inboundMeta.image_path = imagePath
        if (attachment) {
          inboundMeta.attachment_kind = attachment.kind
          inboundMeta.attachment_file_key = attachment.file_key
          if (attachment.name) inboundMeta.attachment_name = attachment.name
        }

        if (rec.origin === "feishu") {
          // feishu-spawn: inject via tmux send-keys instead of MCP channel
          // notification. Claude Code at the idle `❯` prompt after a completed
          // task doesn't auto-process channel notifications — we saw it
          // consistently drop round-2+ inbound during multi-turn testing.
          // send-keys simulates user input, which reliably kicks Claude's
          // input loop.
          const wrapped = wrapForSendKeys(inboundMeta as SendKeysMeta, text)
          const tmuxSession = this.cfg.tmuxSession ?? "claude-feishu"
          const windowName = `fb:${rec.session_id.slice(0, 8)}`
          const target = `${tmuxSession}:${windowName}`
          try {
            const { spawn } = await import("child_process")
            spawn("tmux", ["send-keys", "-t", target, "-l", wrapped], { stdio: "ignore" }).unref()
            setTimeout(() => {
              spawn("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" }).unref()
            }, 300)
            process.stderr.write(`daemon: send-keys inbound to ${target} (thread ${thread_id})\n`)
          } catch (err) {
            process.stderr.write(`daemon: send-keys inbound FAILED for ${target}: ${err}\n`)
          }
          return
        }

        // terminal: push via MCP channel notification (shim forwards to Claude).
        try {
          entry.conn.write(frame({
            push: "inbound",
            content: text,
            meta: inboundMeta,
          }))
          process.stderr.write(`daemon: pushed inbound to session ${rec.session_id} (thread ${thread_id})\n`)
        } catch (err) {
          process.stderr.write(`daemon: push inbound FAILED for ${rec.session_id}: ${err}\n`)
        }
        return
      }
      // Inactive → resume.
      await this.resumeSession(rec, thread_id, event)
      return
    }
    await this.spawnFeishu(event)
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

  // Pending triggering-event payloads to be pushed to shim once it registers.
  // Keyed by session_id. Deleted on first firing.
  private pendingFeishuInbound = new Map<string, { content: string; meta: Record<string, unknown> }>()

  private async spawnFeishu(event: FeishuEvent, preExistingThreadId?: string): Promise<void> {
    const tmux = this.cfg.tmuxSession ?? "claude-feishu"
    const cwd = this.cfg.defaultCwd ?? process.env.FEISHU_DEFAULT_CWD ?? `${process.env.HOME}/workspace`
    const session_id = ulid()
    // Use extractTextAndAttachment so we handle post/text/interactive/etc
    // (the naive JSON.parse(content).text only works for plain text msgs).
    const { text: prompt, attachment } = extractTextAndAttachment(event)

    // Stash the triggering event as an inbound push the shim will deliver once
    // Claude's MCP handshake finishes. Carries the full meta (chat_id, etc.)
    // that Claude needs to call `reply` correctly.
    this.pendingFeishuInbound.set(session_id, {
      content: prompt,
      meta: {
        chat_id: event.message.chat_id,
        message_id: event.message.message_id,
        thread_id: event.message.thread_id,
        user: event.sender.sender_id?.open_id ?? "",
        user_id: event.sender.sender_id?.open_id ?? "",
        ts: new Date(Number(event.message.create_time)).toISOString(),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_key: attachment.file_key,
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
      },
    })

    if (preExistingThreadId) {
      // Topic-group trigger: thread already exists (Feishu auto-created it when
      // the root message was posted). Bind the session to it immediately so the
      // first reply uses seed_thread:false on the existing thread.
      upsertThread(this.threads, preExistingThreadId, {
        session_id, chat_id: event.message.chat_id,
        root_message_id: event.message.message_id, cwd,
        origin: "feishu", status: "active",
        last_active_at: Date.now(), last_message_at: Date.now(),
      })
      saveThreads(this.threadsFile, this.threads)
    } else {
      this.pendingFeishuRoots.set(session_id, {
        chat_id: event.message.chat_id,
        root_message_id: event.message.message_id,
      })
    }

    if (!this.cfg.spawnOverride) await ensureTmuxSession(tmux)
    const cmd = buildSpawnCommand({
      session_id, cwd, initial_prompt: prompt, tmux_session: tmux, kind: "feishu",
    })
    process.stderr.write(`daemon: spawnFeishu session=${session_id} cwd=${cwd}\n`)
    if (this.cfg.spawnOverride) {
      await this.cfg.spawnOverride(cmd.argv, cmd.env)
    } else {
      const { spawn } = await import("child_process")
      const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true })
      child.stdout?.on("data", (b) => process.stderr.write(`spawn stdout: ${b}`))
      child.stderr?.on("data", (b) => process.stderr.write(`spawn stderr: ${b}`))
      child.on("exit", (code) => process.stderr.write(`daemon: spawn exit code=${code}\n`))
      child.unref()
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
    // Use extractTextAndAttachment so we handle post/text/interactive/etc
    // (the naive JSON.parse(content).text only works for plain text msgs).
    const { text: prompt, attachment } = extractTextAndAttachment(event)
    // Stage the reply as a pendingFeishuInbound so handleRegister injects it
    // via tmux send-keys once the respawned shim reconnects — same delivery
    // path as fresh feishu-spawn. Without this, resume would bring up a
    // Claude pane with no idea why and silently drop the user's message.
    this.pendingFeishuInbound.set(rec.session_id, {
      content: prompt,
      meta: {
        chat_id: event.message.chat_id,
        message_id: event.message.message_id,
        thread_id,
        user: event.sender.sender_id?.open_id ?? "",
        user_id: event.sender.sender_id?.open_id ?? "",
        ts: new Date(Number(event.message.create_time)).toISOString(),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_key: attachment.file_key,
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
      },
    })
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

if (import.meta.main) {
  await main().catch((err) => {
    process.stderr.write(`daemon: fatal ${err}\n`); process.exit(1)
  })
}

async function resolveBotOpenId(appId: string, appSecret: string): Promise<string> {
  // Env override wins — users whose app_secret doesn't have contact:user.* scope
  // can paste their bot open_id (visible in any inbound mentions[].id.open_id or
  // in Feishu developer console) into .env and move on.
  const override = process.env.FEISHU_BOT_OPEN_ID?.trim()
  if (override) return override
  try {
    // /bot/v3/info only needs tenant_access_token (no extra scopes), unlike
    // /contact/v3/users/:id which requires contact:user.* scopes most bots lack.
    const tok = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }).then((r) => r.json() as Promise<{ code: number; tenant_access_token?: string }>)
    if (tok.code !== 0 || !tok.tenant_access_token) return ""
    const info = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      headers: { Authorization: `Bearer ${tok.tenant_access_token}` },
    }).then((r) => r.json() as Promise<{ code: number; bot?: { open_id?: string } }>)
    if (info.code !== 0) return ""
    return info.bot?.open_id ?? ""
  } catch {
    return ""
  }
}

async function main(): Promise<void> {
  const { homedir } = await import("os")
  const { readFileSync, chmodSync } = await import("fs")
  const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), ".claude", "channels", "feishu")
  const ENV_FILE = join(STATE_DIR, ".env")
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]
    }
  } catch {}
  const APP_ID = process.env.FEISHU_APP_ID
  const APP_SECRET = process.env.FEISHU_APP_SECRET
  if (!APP_ID || !APP_SECRET) {
    process.stderr.write("daemon: FEISHU_APP_ID / FEISHU_APP_SECRET required\n"); process.exit(1)
  }
  const client = new lark.Client({ appId: APP_ID!, appSecret: APP_SECRET!, domain: lark.Domain.Feishu })
  const { FeishuApi } = await import("./feishu-api")
  const api = new FeishuApi(client as any)

  let botOpenId = await resolveBotOpenId(APP_ID!, APP_SECRET!)
  if (botOpenId) {
    process.stderr.write(`daemon: bot open_id=${botOpenId}\n`)
  } else {
    process.stderr.write("daemon: could not resolve bot open_id at startup — @mention gating will fail for groups with requireMention=true\n")
    process.stderr.write("daemon: set FEISHU_BOT_OPEN_ID in ~/.claude/channels/feishu/.env (find it in Feishu dev console or via any inbound event's mentions[].id.open_id)\n")
  }

  let deliveredDaemon: Daemon | null = null
  // Keep ws + dispatcher at main() scope so they stay referenced for the
  // life of the process (nested fn scope drops them after await returns,
  // which in some bun/Node builds lets GC collect the dispatcher closure).
  let ws: lark.WSClient | null = null
  let dispatcher: lark.EventDispatcher | null = null
  const daemon = await Daemon.start({
    stateDir: STATE_DIR,
    socketPath: join(STATE_DIR, "daemon.sock"),
    feishuApi: api,
    wsStart: async () => {
      dispatcher = new lark.EventDispatcher({})
      dispatcher.register({
        "im.message.receive_v1": async (data: any) => {
          process.stderr.write(`daemon: inbound event from ${data?.sender?.sender_id?.open_id ?? "?"} chat=${data?.message?.chat_id ?? "?"} type=${data?.message?.chat_type ?? "?"} thread=${data?.message?.thread_id ?? "-"}\n`)
          const d = deliveredDaemon
          if (!d) return
          await d.deliverFeishuEvent(data as FeishuEvent, botOpenId).catch((err) => {
            process.stderr.write(`daemon: handler error: ${err}\n`)
          })
        },
      })
      ws = new lark.WSClient({
        appId: APP_ID!, appSecret: APP_SECRET!, domain: lark.Domain.Feishu,
        loggerLevel: (process.env.FEISHU_WS_LOG as any) === "debug"
          ? lark.LoggerLevel.debug
          : (process.env.FEISHU_WS_LOG as any) === "trace"
            ? lark.LoggerLevel.trace
            : lark.LoggerLevel.info,
      })
      await ws.start({ eventDispatcher: dispatcher })
      process.stderr.write("daemon: WebSocket connected\n")
    },
  })
  deliveredDaemon = daemon
  // Belt-and-suspenders keepalive so the event loop has at least one timer
  // and the closures above don't look "finishable" to the GC.
  setInterval(() => { void ws; void dispatcher }, 60000).unref()

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
