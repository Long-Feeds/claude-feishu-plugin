import { createServer, Server, Socket } from "net"
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import * as lark from "@larksuiteoapi/node-sdk"
import { DaemonState } from "./daemon-state"
import { NdjsonParser, frame, type ShimReq, type DaemonMsg } from "./ipc"
import type { ReplyReq } from "./ipc"
import type { ReactReq, EditReq, DownloadReq, PermissionReq, SessionInfoReq, HookPostReq } from "./ipc"
import type { FeishuApi } from "./feishu-api"
import { gate, type FeishuEvent } from "./gate"
import { loadAccess, saveAccess } from "./access"
import { loadThreads, saveThreads, upsertThread, findByThreadId, findBySessionId, markActive, markInactive, pruneInactive, prunePendingRoots, type ThreadStore, type ThreadRecord } from "./threads"
import { buildSpawnCommand, ensureTmuxSession, tmuxNameSlug } from "./spawn"
import { runIdleSweep, sweepIntervalMs } from "./idle-sweep"
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

// How long a UserPromptSubmit-buffered prompt stays eligible to seed the
// terminal-announce title. Sized to comfortably exceed the shim's UUID probe
// deadline (default 30s in shim.ts) plus claude's MCP-server boot time.
// Shorter values silently dropped manual-start prompts whose shim took >10s
// to register, leaving sessions un-announced or titled by an irrelevant
// later prompt.
const PENDING_PROMPT_TTL_MS = Number(process.env.FEISHU_PENDING_PROMPT_TTL_MS ?? "60000")

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
  bridgeHintDelayMs?: number
}

export class Daemon {
  private server: Server
  private state = new DaemonState()
  private pidFile: string
  private accessFile: string
  private threadsFile: string
  private threads: ThreadStore
  // pendingRoots: sessions that have an announce root posted but no thread
  // binding yet (Claude hasn't called reply). Mirrors threads.pendingRoots on
  // disk so this state survives daemon restart — a resumed terminal claude
  // must not trigger a duplicate announce just because daemon was cycled.
  private pendingRoots = new Map<string, { chat_id: string; root_message_id: string }>()
  // pendingFeishuRoots: feishu-spawn sessions waiting for their first reply
  // to seed the thread on the user's original triggering message. In-memory
  // only — feishu-spawn always has a concrete triggering message and will
  // fire its first reply within seconds of spawn.
  private pendingFeishuRoots = new Map<string, { chat_id: string; root_message_id: string }>()
  // Terminal-origin sessions that registered while hubChatId was unset —
  // announce them once the first delivered inbound auto-populates the hub.
  private deferredTerminalAnnounce = new Map<string, { cwd: string }>()
  // cwd-prefix allowlist-out: any terminal session whose cwd starts with one
  // of these paths is silently bridged out — no announce, no pendingRoot, no
  // bridge-hint. Use case: vibe-kanban worktrees spawn many short-lived claude
  // subagents whose announces would spam the hub.
  private ignoredCwdPrefixes: string[] = []
  // cwd → first user prompt buffered because it arrived BEFORE the shim
  // finished registering. Happens in `claude --print` and any other fast
  // spawn: the UserPromptSubmit hook fires as soon as the user hits enter
  // (or, in --print, on CLI-arg parse), while the shim may still be in its
  // 3s jsonl-UUID probe loop. handleRegister drains this map if it sees a
  // matching cwd.
  private pendingUserPrompts = new Map<string, { prompt: string; ts: number }>()

  // Per-session count of MCP `reply` calls within the current Claude turn.
  // Reset on UserPromptSubmit (turn start), incremented on every handleReply,
  // checked in handleHookPost — when reply already ran this turn, the Stop
  // hook's mirror is redundant ("Reply sent." duplicate of Claude's reply
  // content) and gets skipped.
  private turnReplyCounts = new Map<string, number>()

  private constructor(private cfg: DaemonConfig) {
    this.pidFile = join(cfg.stateDir, "daemon.pid")
    this.accessFile = join(cfg.stateDir, "access.json")
    this.threadsFile = join(cfg.stateDir, "threads.json")
    this.threads = loadThreads(this.threadsFile)
    // Hydrate in-memory pendingRoots from persistent store so daemon restarts
    // preserve the "announced but not yet replied" state. Without this,
    // restarting daemon between a terminal announce and Claude's first reply
    // re-announces every shim reconnect.
    for (const [sid, pr] of Object.entries(this.threads.pendingRoots ?? {})) {
      this.pendingRoots.set(sid, { chat_id: pr.chat_id, root_message_id: pr.root_message_id })
    }
    const raw = process.env.FEISHU_IGNORE_CWD_PREFIXES ?? "/var/tmp/vibe-kanban/"
    this.ignoredCwdPrefixes = raw.split(",").map((s) => s.trim()).filter(Boolean)
    this.server = createServer((conn) => this.onConn(conn))
  }

  private isIgnoredCwd(cwd: string): boolean {
    return this.ignoredCwdPrefixes.some((p) => cwd.startsWith(p))
  }

  private persistPendingRoot(
    session_id: string,
    entry: { chat_id: string; root_message_id: string; cwd?: string },
  ): void {
    if (!this.threads.pendingRoots) this.threads.pendingRoots = {}
    this.threads.pendingRoots[session_id] = { ...entry, created_at: Date.now() }
    saveThreads(this.threadsFile, this.threads)
  }

  private clearPendingRoot(session_id: string): void {
    if (this.threads.pendingRoots && this.threads.pendingRoots[session_id]) {
      delete this.threads.pendingRoots[session_id]
      saveThreads(this.threadsFile, this.threads)
    }
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
    // pendingRoots age out independently (shorter window — these are
    // unresolved announces from claudes that never replied). Also rehydrate
    // the in-memory map afterward so it matches the pruned on-disk state.
    const pendingHours = Number(process.env.FEISHU_PENDING_ROOTS_TTL_HOURS ?? "1")
    const pendingTtlMs = Number.isFinite(pendingHours) && pendingHours > 0 ? pendingHours * 3600_000 : 3600_000
    const prunedPending = prunePendingRoots(d.threads, pendingTtlMs)
    if (prunedPending.length > 0) {
      process.stderr.write(`daemon: pruned ${prunedPending.length} pending root(s) older than ${pendingHours}h\n`)
      for (const sid of prunedPending) d.pendingRoots.delete(sid)
      changed = true
    }
    if (changed) saveThreads(d.threadsFile, d.threads)
    await d.bindSocket()
    await cfg.wsStart()
    const sweepMs = sweepIntervalMs(process.env)
    if (sweepMs > 0) {
      // 10-minute warmup keeps reconnect storms (bun sync / systemctl
      // restart) from reading last_message_at as stale for still-live
      // sessions whose shims are mid-reconnect.
      const warmupRaw = Number(process.env.FEISHU_IDLE_SWEEP_WARMUP_MS ?? "600000")
      const initialDelay = Number.isFinite(warmupRaw) && warmupRaw >= 0 ? warmupRaw : 600_000
      setTimeout(() => d.scheduleIdleSweep(sweepMs), initialDelay).unref()
    }
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
    process.stderr.write(`daemon: onConn new socket connection\n`)
    const parser = new NdjsonParser()
    conn.on("data", (buf: Buffer) => {
      parser.feed(buf.toString("utf8"), (msg) => this.onMessage(conn, msg as ShimReq))
    })
    conn.on("close", () => { process.stderr.write(`daemon: onClose socket connection\n`); this.onClose(conn) })
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
      case "hook_post": return void this.handleHookPost(conn, msg as HookPostReq)
      case "user_prompt": return this.handleUserPrompt(conn, msg as Extract<ShimReq, { op: "user_prompt" }>)
      default:
        try {
          conn.write(frame({ id: (msg as any).id, ok: false, error: `unknown op: ${(msg as any).op}` }))
        } catch {}
    }
  }

  private handleRegister(conn: Socket, msg: Extract<ShimReq, { op: "register" }>): void {
    // session_id MUST be the real Claude session UUID (basename of
    // ~/.claude/projects/<cwd-slug>/<uuid>.jsonl). Shim is responsible for
    // resolving it from the jsonl before calling register. Reject anything
    // else — we used to mint a ULID here as a fallback, which led to a
    // two-key ghost state (hooks keyed by UUID, shim keyed by ULID) and
    // every subsequent routing bug was downstream of that compromise.
    process.stderr.write(`daemon: handleRegister session_id=${msg.session_id} cwd=${msg.cwd} pid=${msg.pid}\n`)
    if (!msg.session_id) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "session_id required — shim must resolve claude UUID before register" })) } catch {}
      return
    }
    const session_id: string = msg.session_id

    const regResult = this.state.register({
      session_id, conn, cwd: msg.cwd, pid: msg.pid, registered_at: Date.now(),
      ...(msg.tmux_window_name ? { tmux_window_name: msg.tmux_window_name } : {}),
    })
    if (!regResult.ok && regResult.reason === "duplicate-live-pid") {
      process.stderr.write(
        `daemon: handleRegister REJECTED session_id=${session_id} pid=${msg.pid} ` +
        `— another live shim (pid=${regResult.prev.pid}) is already registered under this id; ` +
        `likely a UUID-probe race. Instructing shim to exit.\n`
      )
      try {
        conn.write(frame({
          id: msg.id, ok: false,
          error: `session_id already claimed by live shim pid=${regResult.prev.pid} — exiting to break UUID-collision loop`,
        }))
      } catch {}
      try { conn.destroy() } catch {}
      return
    }
    // If the session already has a thread binding, flip status back to active
    // (e.g. shim reconnecting after daemon restart, or resume-dedup match).
    if (findBySessionId(this.threads, session_id)) {
      markActive(this.threads, session_id)
      saveThreads(this.threadsFile, this.threads)
    }
    try {
      conn.write(frame({ id: msg.id, ok: true, session_id, thread_id: null }))
    } catch {}

    // Terminal registration paths we skip from any Feishu side-effect:
    //   - feishu-spawned sessions (pendingFeishuInbound carries their trigger),
    //   - sessions that already own a thread (resume of a known session —
    //     route into the existing thread, don't announce again),
    //   - sessions that already have a pendingRoots entry (announce already
    //     posted and waiting for first reply to seed thread),
    //   - cwd matches an ignored prefix (vibe-kanban worktrees by default):
    //     those subagents would otherwise spam the hub every time the harness
    //     fires up a fresh `claude`.
    //
    // The announce itself is DEFERRED — we no longer post `🟢 session online`
    // at register time. The title of the announce comes from the user's FIRST
    // prompt (UserPromptSubmit hook → handleUserPrompt), so operators can tell
    // at a glance what the session is working on. Register-time still pushes
    // the bridge-hint inbound so Claude knows about the mirror before turn 1.
    // feishu-spawn resolution: shim registered with a real UUID (probed
    // from the jsonl that claude wrote when we send-keys'd the trigger
    // prompt into the pane). Pair it with the cwd-keyed spawn intent
    // parked by spawnFeishu.
    //
    // The intent is keyed by cwd, but we REQUIRE the registering shim's
    // tmux_window_name to match the window that spawnFeishu created. Without
    // that check, any other shim registering in the same cwd (e.g. a stale
    // shim from a prior window stuck in a reconnect loop due to a shared
    // session_id) could steal the intent, binding the new feishu thread to
    // an unrelated old session. When that happens the real shim's later
    // reply falls through to the terminal path and posts as a new root
    // message — i.e. what looks to the operator like "this reply became a
    // new topic instead of threading under the user's question."
    const spawnIntent = this.pendingFeishuSpawns.get(msg.cwd)
    const spawnIntentMatches =
      !!spawnIntent && spawnIntent.windowName === msg.tmux_window_name
    if (spawnIntent && !spawnIntentMatches) {
      process.stderr.write(
        `daemon: handleRegister ignoring pendingFeishuSpawns[${msg.cwd}] — ` +
        `window_name mismatch (intent=${spawnIntent.windowName} vs msg=${msg.tmux_window_name ?? "<none>"}); ` +
        `likely a stale shim in the same cwd\n`
      )
    }
    if (spawnIntent && spawnIntentMatches) {
      this.pendingFeishuSpawns.delete(msg.cwd)
      // Bind the feishu state to the real UUID now that we know it.
      if (spawnIntent.preExistingThreadId) {
        upsertThread(this.threads, spawnIntent.preExistingThreadId, {
          session_id, chat_id: spawnIntent.event.message.chat_id,
          root_message_id: spawnIntent.event.message.message_id, cwd: msg.cwd,
          origin: "feishu", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
          ...(msg.tmux_window_name ? { tmux_window_name: msg.tmux_window_name } : {}),
        })
        saveThreads(this.threadsFile, this.threads)
      } else {
        this.pendingFeishuRoots.set(session_id, {
          chat_id: spawnIntent.event.message.chat_id,
          root_message_id: spawnIntent.event.message.message_id,
        })
      }
      process.stderr.write(`daemon: feishu-spawn bound cwd=${msg.cwd} session=${session_id}\n`)
    }
    const isFeishuSpawn =
      this.pendingFeishuInbound.has(session_id) || spawnIntentMatches
    const alreadyBound = !!findBySessionId(this.threads, session_id)
    const alreadyPending = this.pendingRoots.has(session_id)
    const ignoredCwd = this.isIgnoredCwd(msg.cwd)
    if (ignoredCwd) {
      process.stderr.write(`daemon: terminal register ignored (cwd=${msg.cwd} matches an ignore prefix) session=${session_id}\n`)
    } else if (
      !isFeishuSpawn && !alreadyBound && !alreadyPending &&
      this.cfg.feishuApi
    ) {
      const hub = loadAccess(this.accessFile).hubChatId
      if (hub) {
        this.scheduleBridgeHint(session_id, hub)
        // Drain: a UserPromptSubmit hook that arrived before register (common
        // in `claude --print` where the shim's 3s UUID probe lets the hook
        // frame win the race) parked its prompt in pendingUserPrompts keyed
        // by cwd. If we have one fresh enough, announce with it right now.
        const buffered = this.pendingUserPrompts.get(msg.cwd)
        if (buffered && Date.now() - buffered.ts < PENDING_PROMPT_TTL_MS) {
          this.pendingUserPrompts.delete(msg.cwd)
          this.sendTerminalAnnounce(session_id, hub, msg.cwd, this.titleFromPrompt(buffered.prompt))
        }
      } else {
        this.deferredTerminalAnnounce.set(session_id, { cwd: msg.cwd })
        process.stderr.write(`daemon: terminal session=${session_id} registered but hubChatId unset — deferred; first inbound will auto-populate + bridge-hint\n`)
      }
    }
    // Drain pendingFeishuInbound: resumeSession stages an entry here so the
    // respawned shim's register triggers send-keys of the user's message
    // that needed a resume. Fresh spawnFeishu no longer uses this path
    // (send-keys is fired directly from spawnFeishu's setTimeout).
    const pending = this.pendingFeishuInbound.get(session_id)
    if (pending) {
      this.pendingFeishuInbound.delete(session_id)
      this.scheduleFeishuSendKeys(session_id, pending.windowName, pending.content, pending.meta)
    }
  }

  // Truncate to a reasonable single-line title for the announce root. Feishu
  // renders the whole markdown block, but a multi-paragraph prompt as a
  // title is unreadable in the thread list.
  private titleFromPrompt(prompt: string): string {
    const firstLine = prompt.split("\n")[0]?.trim() ?? ""
    const collapsed = firstLine.replace(/\s+/g, " ")
    if (collapsed.length > 200) return collapsed.slice(0, 200).trimEnd() + "…"
    return collapsed || "Claude Code session online"
  }

  private sendTerminalAnnounce(session_id: string, hub: string, cwd: string, title: string): void {
    if (!this.cfg.feishuApi) return
    // Markdown format so the blockquote for cwd / session renders cleanly in
    // the feishu chat UI. Rendering falls back to plain text on clients that
    // don't support feishu post-md, and the source is still readable either way.
    const text = [
      `🟢 ${title}`,
      `> cwd: \`${cwd}\``,
      `> session: \`${session_id}\``,
    ].join("\n")
    this.cfg.feishuApi.sendRoot({
      chat_id: hub,
      text,
      format: "markdown",
    }).then((res) => {
      // Prime pendingRoots so the session's first MCP reply seeds a thread
      // off this announce rather than creating a second root message. Also
      // persist so a daemon restart between announce and first reply doesn't
      // trigger a duplicate announce on shim reconnect. cwd is stored so
      // hook_post can fall back to it if the hook's claude_session_uuid
      // doesn't match the shim's registered session_id (common when the
      // shim couldn't resolve the UUID in time and registered with a ULID).
      const entry = { chat_id: hub, root_message_id: res.message_id }
      this.pendingRoots.set(session_id, entry)
      this.persistPendingRoot(session_id, { ...entry, cwd })
      process.stderr.write(`daemon: terminal auto-announce session=${session_id} hub=${hub} msg=${res.message_id} title="${title.slice(0, 60)}"\n`)
    }).catch((e) => process.stderr.write(`daemon: terminal auto-announce failed: ${e}\n`))
  }

  private scheduleBridgeHint(session_id: string, hub: string): void {
    // Delay so Claude's MCP handshake + welcome-screen processing has time
    // to complete. Channel notifications delivered during MCP init get
    // swallowed (same reason feishu-spawn uses tmux send-keys with 5s delay).
    // Tests override via bridgeHintDelayMs.
    const hintDelay = this.cfg.bridgeHintDelayMs ?? 5000
    setTimeout(() => {
      const entry = this.state.get(session_id)
      if (!entry) {
        process.stderr.write(`daemon: bridge-hint SKIPPED session=${session_id} (shim no longer registered after ${hintDelay}ms)\n`)
        return
      }
      try {
        entry.conn.write(frame({
          push: "inbound",
          content:
            "⚡ FEISHU BRIDGE — this Claude session is mirroring to a Feishu group. " +
            "IMPORTANT: after each meaningful milestone (task start, key finding, " +
            "blocker, completion), you MUST call the feishu `reply` tool with " +
            `chat_id="${hub}" and a concise one-paragraph summary. Remote observers ` +
            "only see what you post via `reply` — your transcript does not reach them. " +
            "Skip trivia; don't narrate every bash call. Aim for 3-6 updates per task.",
          meta: {
            chat_id: hub,
            initial: "true",
            source: "feishu-bridge-hint",
          },
        }))
        process.stderr.write(`daemon: bridge-hint pushed to session=${session_id}\n`)
      } catch (e) {
        process.stderr.write(`daemon: bridge-hint push FAILED session=${session_id}: ${e}\n`)
      }
    }, hintDelay)
  }

  private announceDeferredTerminalSessions(hub: string): void {
    if (this.deferredTerminalAnnounce.size === 0) return
    // Hub just became known. Mirror the hub-present branch of handleRegister:
    // bridge-hint + a root announce, seeding pendingRoots so subsequent
    // Stop-hook mirrors from this session have a thread to attach to. Without
    // the announce, those mirrors hit `no thread or pendingRoot match` and
    // get dropped until Claude explicitly calls reply — which breaks the
    // automatic mirroring flow for any session that registered before hub
    // was set. Prefer a buffered first prompt as the title; otherwise fall
    // back to the generic announce.
    for (const [session_id, { cwd }] of this.deferredTerminalAnnounce) {
      this.scheduleBridgeHint(session_id, hub)
      const buffered = this.pendingUserPrompts.get(cwd)
      const titleSource = buffered && Date.now() - buffered.ts < PENDING_PROMPT_TTL_MS
        ? buffered.prompt
        : undefined
      if (titleSource !== undefined) this.pendingUserPrompts.delete(cwd)
      const title = titleSource !== undefined
        ? this.titleFromPrompt(titleSource)
        : "Claude Code session online"
      this.sendTerminalAnnounce(session_id, hub, cwd, title)
    }
    this.deferredTerminalAnnounce.clear()
  }

  private handleUserPrompt(conn: Socket, msg: Extract<ShimReq, { op: "user_prompt" }>): void {
    // Fire-and-forget: hook scripts don't wait for a response, but we still
    // write one so sendFrame's 2s wait can resolve early.
    try { conn.write(frame({ id: msg.id, ok: true })) } catch {}

    const uuid = msg.claude_session_uuid
    const cwd = msg.cwd
    if (!cwd) return
    if (this.isIgnoredCwd(cwd)) return
    if (!this.cfg.feishuApi) return
    // Defense in depth: the hook already filters channel-wrapped prompts and
    // the bridge-hint, but one stray variant (seen in the wild:
    // `<channel source="plugin:feishu:feishu" ...>`) leaked past an
    // over-narrow earlier filter and became a thread title. Re-check here so
    // a broken hook can never poison the announce title again.
    const p = msg.prompt.trimStart()
    if (p.startsWith("<channel") || p.startsWith("⚡ FEISHU BRIDGE")) {
      process.stderr.write(`daemon: user_prompt suppressed (channel/bridge-hint echo) cwd=${cwd}\n`)
      return
    }
    // Real user prompt = turn boundary. Reset the per-turn reply counter so
    // the Stop hook can decide whether its mirror is redundant for THIS turn.
    if (uuid) this.turnReplyCounts.delete(uuid)

    // Find the session this prompt belongs to. The hook ships the Claude-side
    // session UUID; shims register either with that same UUID or with a ULID
    // fallback. Prefer UUID match, then cwd match on pendingRoots, then
    // thread binding.
    const byUuidThread = uuid ? findBySessionId(this.threads, uuid) : undefined
    const byUuidPending = uuid ? this.pendingRoots.has(uuid) : false
    const byUuidFeishuRoot = uuid ? this.pendingFeishuRoots.has(uuid) : false
    if (byUuidThread || byUuidPending || byUuidFeishuRoot) {
      // Session already has a binding somewhere — announce already done (or
      // feishu-spawn owns the root). Subsequent prompts are no-ops.
      return
    }
    // UUID isn't bound. First try a direct UUID → SessionEntry lookup: the
    // shim usually registers under the same claude_session_uuid the hook
    // ships, and when two panes share a cwd this is the only way to route
    // the prompt to the right session (cwd-newest would bind the title to
    // whichever pane registered last). Only fall back to cwd-newest when
    // the shim registered under a different id — happens when the jsonl
    // UUID probe timed out and it had to use a ULID fallback.
    const target =
      (uuid ? this.state.get(uuid) : undefined)
      ?? this.state.findNewestTerminalForCwd(cwd)
    if (!target) {
      // No shim registered yet for this cwd — park the prompt so the next
      // handleRegister (probably seconds away; shim is probing UUID) can
      // fire the announce with this prompt as the title.
      //
      // Manual-start race: when the user runs `claude` from a terminal, the
      // shim's UUID probe (default 30s) can elapse while the user is typing
      // additional prompts. The original user intent is the FIRST prompt
      // they submitted, not whichever one happened to land last before the
      // shim came online. Keep the first; ignore later submissions during
      // the same startup window.
      const existing = this.pendingUserPrompts.get(cwd)
      const now = Date.now()
      if (existing && now - existing.ts < PENDING_PROMPT_TTL_MS) {
        process.stderr.write(`daemon: user_prompt skipped (cwd=${cwd}) — earlier prompt still buffered as title candidate\n`)
        return
      }
      this.pendingUserPrompts.set(cwd, { prompt: msg.prompt, ts: now })
      process.stderr.write(`daemon: user_prompt buffered (no live shim yet for cwd=${cwd}, uuid=${uuid})\n`)
      return
    }
    if (findBySessionId(this.threads, target.session_id)) return
    if (this.pendingRoots.has(target.session_id)) return
    if (this.pendingFeishuRoots.has(target.session_id)) return

    const hub = loadAccess(this.accessFile).hubChatId
    if (!hub) return

    const title = this.titleFromPrompt(msg.prompt)
    this.sendTerminalAnnounce(target.session_id, hub, cwd, title)
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
    const format = msg.format ?? "markdown"
    const bound = findBySessionId(this.threads, entry.session_id)
    const pending = this.pendingRoots.get(entry.session_id)
    const feishuRoot = this.pendingFeishuRoots.get(entry.session_id)
    // Mark this turn as having had a reply call. Stop hook will see the
    // counter > 0 and skip its mirror so feishu doesn't get a near-duplicate
    // of Claude's actual reply text right after Claude's reply tool call.
    this.turnReplyCounts.set(entry.session_id, (this.turnReplyCounts.get(entry.session_id) ?? 0) + 1)

    const files = msg.files ?? []
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
          ...(entry.tmux_window_name ? { tmux_window_name: entry.tmux_window_name } : {}),
        })
        saveThreads(this.threadsFile, this.threads)
        this.pendingFeishuRoots.delete(entry.session_id)
        await this.sendAttachments(feishuRoot.chat_id, files)
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
        const pr = { chat_id: chat_home, root_message_id: res.message_id }
        this.pendingRoots.set(entry.session_id, pr)
        this.persistPendingRoot(entry.session_id, pr)
        await this.sendAttachments(chat_home, files)
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
          ...(entry.tmux_window_name ? { tmux_window_name: entry.tmux_window_name } : {}),
        })
        this.pendingRoots.delete(entry.session_id)
        this.clearPendingRoot(entry.session_id)   // also removes from disk
        saveThreads(this.threadsFile, this.threads)
        await this.sendAttachments(pending.chat_id, files)
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
        await this.sendAttachments(bound.chat_id, files)
        conn.write(frame({ id: msg.id, ok: true, message_id: res.message_id, thread_id: bound.thread_id }))
        return
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      try { conn.write(frame({ id: msg.id, ok: false, error: m })) } catch {}
    }
  }

  // Feishu's thread endpoint doesn't accept file/image messages, so we send
  // attachments as separate top-level messages to the same chat — matches the
  // monolith server.ts behavior before the daemon/shim split. Size is
  // preflighted so a too-large file surfaces a readable error instead of an
  // opaque upload failure from the Feishu API.
  private async sendAttachments(chat_id: string, files: string[]): Promise<void> {
    if (files.length === 0 || !this.cfg.feishuApi) return
    const MAX = 50 * 1024 * 1024
    for (const path of files) {
      const st = statSync(path)
      if (st.size > MAX) {
        throw new Error(`file too large: ${path} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
      }
    }
    for (const path of files) {
      await this.cfg.feishuApi.sendFile({ chat_id, path })
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
      await this.cfg.feishuApi.edit({ message_id: msg.message_id, text: msg.text, format: msg.format ?? "markdown" })
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
      `🔐 **Permission**: \`${msg.tool_name}\`\n` +
      `> ${msg.description}\n\n` +
      `\`\`\`json\n${prettyInput}\n\`\`\`\n\n` +
      `Reply \`y ${msg.request_id}\` to allow or \`n ${msg.request_id}\` to deny.`
    if (this.cfg.feishuApi) {
      const bound = findBySessionId(this.threads, entry.session_id)
      if (bound) {
        this.cfg.feishuApi.sendInThread({
          root_message_id: bound.root_message_id, text, format: "markdown", seed_thread: false,
        }).catch((e) => { process.stderr.write(`daemon: permission relay (in-thread) failed: ${e}\n`) })
      } else {
        const hub = loadAccess(this.accessFile).hubChatId
        if (hub) {
          this.cfg.feishuApi.sendRoot({ chat_id: hub, text, format: "markdown" })
            .catch((e) => { process.stderr.write(`daemon: permission relay (hub) failed: ${e}\n`) })
        }
      }
    }
    try { conn.write(frame({ id: msg.id, ok: true })) } catch {}
  }

  private async handleHookPost(conn: Socket, msg: HookPostReq): Promise<void> {
    // Plugin Stop-hook pushing "Claude just finished a turn, here's the text."
    // Route to the terminal session's existing feishu thread so remote
    // observers get the update without Claude having to call reply itself.
    // Lookup order:
    //   1. claude_session_uuid === any session's session_id (shim normally
    //      uses the same UUID when it resolved the project-dir jsonl in time).
    //   2. threads.json has a terminal thread record whose session_id matches
    //      the UUID (same as #1 but via persistent store, e.g. after daemon
    //      restart).
    //   3. Fallback: newest terminal-origin thread bound to this cwd.
    // If none match, drop silently — this is a best-effort mirror.
    if (!this.cfg.feishuApi) {
      try { conn.write(frame({ id: msg.id, ok: false, error: "feishu api not configured" })) } catch {}
      return
    }
    const uuid = msg.claude_session_uuid
    const thread: ThreadRecord & { thread_id: string } | undefined =
      uuid ? findBySessionId(this.threads, uuid) : undefined
    // If Claude already called the `reply` MCP tool during this turn, the
    // Stop hook's mirror would just duplicate Claude's reply content (the
    // hook captures the assistant's final text — typically a "Reply sent"
    // / "已回复" follow-up after the tool call). Skip and ack so the shim
    // doesn't see this as an error.
    const replies = uuid ? (this.turnReplyCounts.get(uuid) ?? 0) : 0
    if (uuid) this.turnReplyCounts.delete(uuid)
    if (replies > 0) {
      process.stderr.write(`daemon: hook_post mirror skipped — session ${uuid} called reply ${replies}x this turn\n`)
      try { conn.write(frame({ id: msg.id, ok: true, skipped: "reply-fired" })) } catch {}
      return
    }
    try {
      if (thread && thread.status !== "closed") {
        await this.cfg.feishuApi.sendInThread({
          root_message_id: thread.root_message_id,
          text: msg.text,
          format: "markdown",
          seed_thread: false,
        })
        this.threads.threads[thread.thread_id]!.last_message_at = Date.now()
        saveThreads(this.threadsFile, this.threads)
        conn.write(frame({ id: msg.id, ok: true, thread_id: thread.thread_id }))
        process.stderr.write(`daemon: hook_post routed to thread=${thread.thread_id} session=${thread.session_id}\n`)
        return
      }
      // Session hasn't produced a thread binding yet — it's still in
      // pendingRoots (announce posted but no MCP reply yet). Post the hook
      // text as a threaded reply off the announce root; that seeds the
      // thread. Because every map is keyed by the real UUID now, direct
      // lookup by uuid is the only path — no cwd-fallback needed.
      const pending = uuid ? this.pendingRoots.get(uuid) : undefined
      if (pending && uuid) {
        const res = await this.cfg.feishuApi.sendInThread({
          root_message_id: pending.root_message_id,
          text: msg.text,
          format: "markdown",
          seed_thread: true,
        })
        if (res.thread_id) {
          upsertThread(this.threads, res.thread_id, {
            session_id: uuid,
            chat_id: pending.chat_id,
            root_message_id: pending.root_message_id,
            cwd: msg.cwd,
            origin: "terminal", status: "active",
            last_active_at: Date.now(), last_message_at: Date.now(),
          })
          this.pendingRoots.delete(uuid)
          this.clearPendingRoot(uuid)
          saveThreads(this.threadsFile, this.threads)
          process.stderr.write(`daemon: hook_post seeded thread=${res.thread_id} session=${uuid}\n`)
        }
        conn.write(frame({ id: msg.id, ok: true }))
        return
      }
      process.stderr.write(`daemon: hook_post NO ROUTE uuid=${uuid} cwd=${msg.cwd} — dropping\n`)
      conn.write(frame({ id: msg.id, ok: false, error: "no thread or pendingRoot match" }))
    } catch (err) {
      try { conn.write(frame({ id: msg.id, ok: false, error: (err as Error).message })) } catch {}
    }
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
            text: "🔒 **thread closed** — send a new top-level message for a new session",
            format: "markdown", seed_thread: false,
          }).catch(() => {})
        }
        return
      }
      // Inbound user activity advances the idle clock. Without this, an
      // already-hibernated thread the user is now reviving stays "stale" by
      // last_message_at until Claude produces its first outbound reply
      // (handleReply / hook_post mirror) — a window that can be many seconds
      // and is not guaranteed (resume could fail). The next sweep tick would
      // then re-fire the hibernate notice on a thread the user is actively
      // chatting in. Persisting because saveThreads is the only durable
      // signal between daemon ticks.
      this.threads.threads[thread_id]!.last_message_at = Date.now()
      saveThreads(this.threadsFile, this.threads)
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
          //
          // Window name comes from the SessionEntry (shim reported it from
          // $TMUX_PANE at register time). Don't recompute from session_id —
          // that broke fresh feishu-spawn, where the pane name is random
          // because Claude's UUID isn't known at spawn time.
          const windowName = entry.tmux_window_name
          if (!windowName) {
            process.stderr.write(`daemon: send-keys inbound DROPPED — session ${rec.session_id} has no tmux_window_name (thread ${thread_id})\n`)
            if (this.cfg.feishuApi) {
              this.cfg.feishuApi.reactTo(event.message.message_id, "CrossMark").catch(() => {})
            }
            return
          }
          const wrapped = wrapForSendKeys(inboundMeta as SendKeysMeta, text)
          const tmuxSession = this.cfg.tmuxSession ?? "claude-feishu"
          const target = `${tmuxSession}:${windowName}`
          await this.tmuxSendKeysWithEnter(target, wrapped, `inbound thread=${thread_id}`)
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
      text: `**${lead}** — run in Claude Code:\n\n\`/feishu:access pair ${code}\``,
      format: "markdown",
    }).catch((e) => { process.stderr.write(`daemon: pair reply failed: ${e}\n`) })
  }

  // Pending triggering-event payloads to be pushed to shim once it registers.
  // Keyed by session_id (real Claude UUID). Deleted after send-keys fires.
  private pendingFeishuInbound = new Map<string, { content: string; meta: Record<string, unknown>; windowName: string }>()
  // In-flight feishu-spawn intents — keyed by cwd so handleRegister can
  // recognize a registering shim as feishu-spawn even when daemon's jsonl
  // UUID poll hasn't completed yet (they run in parallel; shim often
  // registers milliseconds before daemon's poll ticks). Without this the
  // session gets misclassified as terminal-origin → bridge-hint fires →
  // we pollute a feishu-spawn session with hub mirroring.
  private pendingFeishuSpawns = new Map<string, {
    event: FeishuEvent
    preExistingThreadId?: string
    windowName: string
    prompt: string
    attachment: ReturnType<typeof extractTextAndAttachment>["attachment"]
    startedAt: number
  }>()

  private async spawnFeishu(event: FeishuEvent, preExistingThreadId?: string): Promise<void> {
    const tmux = this.cfg.tmuxSession ?? "claude-feishu"
    const rawCwd = this.cfg.defaultCwd ?? process.env.FEISHU_DEFAULT_CWD ?? `${process.env.HOME}/workspace`
    // Canonicalize: claude's jsonl goes under a slug derived from its ACTUAL
    // cwd (from /proc/self/cwd, i.e. the physical path). Without realpath,
    // a symlink cwd like `/home/xiaolong -> /data00/home/xiaolong` would
    // yield a slug that doesn't match claude's, and the shim's UUID probe
    // would fail.
    const { realpathSync } = await import("fs")
    let cwd = rawCwd
    try { cwd = realpathSync(rawCwd) } catch { /* keep rawCwd as-is */ }
    const { text: prompt, attachment } = extractTextAndAttachment(event)
    // Window name carries the prompt's first 5 chars for at-a-glance
    // identification in `tmux list-windows` (otherwise every fb: window looks
    // like an opaque random string). The trailing random suffix preserves
    // uniqueness across concurrent spawns of the same prompt.
    const slug = tmuxNameSlug(prompt, 5)
    const rand = Math.random().toString(36).slice(2, 8)
    const windowName = slug ? `fb:${slug}-${rand}` : `fb:${rand}`

    // Flow reality: Claude Code does NOT write the session jsonl until the
    // FIRST user prompt lands in the session (MCP init alone doesn't
    // trigger it; we verified empirically that a fresh idle `claude` writes
    // nothing for >5s). So UUID resolution is unavoidably downstream of
    // send-keys: we need to push the prompt into the pane to make claude
    // write jsonl, at which point the shim's probe finds it and registers.
    // That means daemon cannot poll for UUID BEFORE sending the prompt,
    // contrary to the earlier "poll first, then inject" design.
    //
    // Working sequence:
    //   1. Mark pendingFeishuSpawns[cwd] so handleRegister knows this
    //      incoming shim is feishu-origin even before UUID-specific
    //      binding exists.
    //   2. Spawn tmux.
    //   3. After 5s (claude past welcome screen), send-keys the prompt.
    //   4. Claude processes → jsonl written → shim's 10s probe finds it →
    //      shim registers with the real UUID → handleRegister finalizes
    //      the thread binding (feishu-spawn branch, using cwd lookup).
    this.pendingFeishuSpawns.set(cwd, {
      event, preExistingThreadId, windowName, prompt, attachment, startedAt: Date.now(),
    })

    if (!this.cfg.spawnOverride) await ensureTmuxSession(tmux)
    const cmd = buildSpawnCommand({
      cwd, initial_prompt: prompt, tmux_session: tmux, kind: "feishu",
      window_name: windowName,
    })
    process.stderr.write(`daemon: spawnFeishu cwd=${cwd} window=${windowName}\n`)
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

    // Send-keys the triggering prompt after a short delay so claude's
    // welcome screen has resolved. Tests override to zero via spawnOverride.
    const inboundMeta = this.buildInboundMeta(event, attachment)
    const delay = this.cfg.spawnOverride ? 0 : 5000
    setTimeout(() => this.sendKeysIntoPane(windowName, prompt, inboundMeta), delay)

    // Give up on this spawn if shim never registers (claude crashed,
    // jsonl-write wedged, etc.). Acts as the "UUID not resolvable" error
    // path the user asked for — we react ❌ and reply in-thread.
    const giveUpMs = Number(process.env.FEISHU_SPAWN_REGISTER_TIMEOUT_MS ?? "30000")
    setTimeout(() => {
      const entry = this.pendingFeishuSpawns.get(cwd)
      if (!entry || entry.startedAt >= Date.now() - giveUpMs + 100) return // superseded
      this.pendingFeishuSpawns.delete(cwd)
      process.stderr.write(`daemon: spawnFeishu REGISTER TIMEOUT cwd=${cwd} after ${giveUpMs}ms\n`)
      if (this.cfg.feishuApi) {
        const trigger = event.message.message_id
        this.cfg.feishuApi.reactTo(trigger, "CrossMark").catch(() => {})
        this.cfg.feishuApi.sendInThread({
          root_message_id: trigger,
          text: `❌ Failed to start claude session in \`${cwd}\` — shim never registered within ${giveUpMs}ms. Check daemon logs.`,
          format: "markdown", seed_thread: !preExistingThreadId,
        }).catch(() => {})
      }
    }, giveUpMs)
  }

  private buildInboundMeta(event: FeishuEvent, attachment: ReturnType<typeof extractTextAndAttachment>["attachment"]): Record<string, unknown> {
    return {
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
    }
  }

  // Fire-and-forget tmux send-keys that still surfaces failures. Hooks an
  // exit listener so "can't find window" / non-zero exit gets logged instead
  // of silently dropping the inbound (the bug that hid the original window-
  // name routing mismatch for so long). Returns a promise that resolves once
  // both the literal payload and the trailing Enter have been queued.
  private async tmuxSendKeysWithEnter(target: string, payload: string, ctx: string): Promise<void> {
    try {
      const { spawn } = await import("child_process")
      const literal = spawn("tmux", ["send-keys", "-t", target, "-l", payload], { stdio: "ignore" })
      literal.on("exit", (code) => {
        if (code !== 0) process.stderr.write(`daemon: send-keys literal FAILED on ${target} exit=${code} (${ctx})\n`)
      })
      literal.unref()
      setTimeout(() => {
        const enter = spawn("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" })
        enter.on("exit", (code) => {
          if (code !== 0) process.stderr.write(`daemon: send-keys Enter FAILED on ${target} exit=${code} (${ctx})\n`)
        })
        enter.unref()
      }, 300)
      process.stderr.write(`daemon: send-keys to ${target} (${ctx})\n`)
    } catch (err) {
      process.stderr.write(`daemon: send-keys threw on ${target} (${ctx}): ${err}\n`)
    }
  }

  private async sendKeysIntoPane(windowName: string, content: string, meta: Record<string, unknown>): Promise<void> {
    const tmuxSession = this.cfg.tmuxSession ?? "claude-feishu"
    try {
      const { spawn } = await import("child_process")
      const target = `${tmuxSession}:${windowName}`
      const wrapped = wrapForSendKeys(meta as SendKeysMeta, content)
      // Two-stage prime: a fresh claude in an un-trusted cwd shows a
      // "Is this a project you trust?" dialog that eats keystrokes and
      // swallows the subsequent --dangerously-load-development-channels
      // experimental-splash too. Sending a priming Enter dismisses any
      // such dialog (trust default is "Yes, I trust this folder"; splash
      // dismisses on Enter); then we wait for claude to settle at the
      // `❯` prompt before sending the real payload.
      const prime = spawn("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" })
      prime.on("exit", (code) => {
        if (code !== 0) process.stderr.write(`daemon: send-keys prime FAILED on ${target} exit=${code}\n`)
      })
      prime.unref()
      setTimeout(() => this.tmuxSendKeysWithEnter(target, wrapped, `initial window=${windowName}`), 1500)
      process.stderr.write(`daemon: send-keys into tmux window ${windowName}\n`)
    } catch (err) {
      process.stderr.write(`daemon: send-keys failed on ${windowName}: ${err}\n`)
    }
  }

  // Extracted from the old handleRegister inline setTimeout — now both
  // handleRegister (normal order: daemon-poll completes first) and
  // spawnFeishu (race order: shim-register completes first) can call it.
  private scheduleFeishuSendKeys(session_id: string, windowName: string, content: string, meta: Record<string, unknown>): void {
    const tmuxSession = this.cfg.tmuxSession ?? "claude-feishu"
    setTimeout(() => {
      const target = `${tmuxSession}:${windowName}`
      const wrapped = wrapForSendKeys(meta as SendKeysMeta, content)
      this.tmuxSendKeysWithEnter(target, wrapped, `resume-inbound session=${session_id}`)
    }, 5000)
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
    const windowName = `fb:${rec.session_id.slice(0, 8)}`
    this.pendingFeishuInbound.set(rec.session_id, {
      content: prompt,
      windowName,
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
    // session_id IS the Claude session UUID now, so use it for both
    // FEISHU_SESSION_ID env (shim short-circuits its probe) and the
    // `claude --resume <uuid>` argument. rec.claude_session_uuid is only
    // kept for backward-compat with older threads.json records.
    const resumeUuid = rec.claude_session_uuid ?? rec.session_id
    const cmd = buildSpawnCommand({
      session_id: rec.session_id, cwd: rec.cwd, initial_prompt: prompt,
      tmux_session: tmux, kind: "resume",
      claude_session_uuid: resumeUuid,
      window_name: windowName,
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

  private scheduleIdleSweep(delayMs: number): void {
    setTimeout(async () => {
      try { await this.runIdleSweepOnce(Date.now()) }
      catch (err) { process.stderr.write(`daemon: idle sweep threw ${err}\n`) }
      this.scheduleIdleSweep(delayMs)
    }, delayMs).unref()
  }

  // Exposed for tests and for one-shot operator-triggered runs. Never throws.
  async runIdleSweepOnce(now: number): Promise<{ killed: string[] }> {
    const idleHoursRaw = Number(process.env.FEISHU_IDLE_KILL_HOURS ?? "24")
    const idleHours = Number.isFinite(idleHoursRaw) && idleHoursRaw > 0 ? idleHoursRaw : 24
    const idleMs = idleHours * 3600_000
    const maxRaw = Number(process.env.FEISHU_IDLE_SWEEP_MAX ?? "20")
    const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 20
    const result = await runIdleSweep({
      threads: this.threads,
      saveThreads: (s) => saveThreads(this.threadsFile, s),
      feishuApi: this.cfg.feishuApi,
      killTmuxWindow: (sess, name) => this.killTmuxWindow(sess, name),
      daemonState: this.state,
      tmuxSession: this.cfg.tmuxSession ?? "claude-feishu",
      now, idleMs, max,
      log: (msg) => process.stderr.write(`${msg}\n`),
    })
    if (result.killed.length > 0) {
      process.stderr.write(`daemon: idle sweep processed ${result.killed.length} session(s)\n`)
    }
    return result
  }

  // Test-friendly: defers to spawnOverride when present so assertions can
  // observe the exact tmux command without shelling out.
  private async killTmuxWindow(session: string, windowName: string): Promise<void> {
    const argv = ["tmux", "kill-window", "-t", `${session}:${windowName}`]
    if (this.cfg.spawnOverride) {
      const code = await this.cfg.spawnOverride(argv, {})
      if (code !== 0) throw new Error(`kill-window spawnOverride exit=${code}`)
      return
    }
    const { spawn } = await import("child_process")
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" })
      child.once("error", reject)
      child.once("exit", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tmux kill-window exit=${code}`))
      })
    })
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
