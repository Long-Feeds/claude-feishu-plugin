// Resolve the effective "workdir" the user thinks of when they see their
// terminal claude session in Feishu.
//
// Problem: Claude Code launches our MCP shim via
//   bun run --cwd ${CLAUDE_PLUGIN_ROOT} --silent shim
// The `--cwd` flag makes bun chdir to the plugin directory before exec, so
// `process.cwd()` inside shim is always the plugin path, never the terminal
// the user started `claude` in. Reporting that as the session cwd makes
// every "🟢 session online" announce look identical (same plugin path)
// instead of distinguishing sessions by the project they're attached to.
//
// Fix: walk up the parent process chain (Linux /proc) to find the nearest
// ancestor whose comm is "claude" and return its cwd. That's the directory
// the user actually typed `claude` in.
//
// Platform note: relies on /proc, i.e. Linux. On other OSes the helper
// falls back to process.cwd() transparently.

import { readFileSync, readlinkSync, readdirSync } from "fs"

export type ProcFs = {
  readStatus: (pid: number) => string | null
  readCwd: (pid: number) => string | null
  readComm: (pid: number) => string | null
  listFds?: (pid: number) => string[]   // absolute paths behind /proc/<pid>/fd/*
}

export const realProcFs: ProcFs = {
  readStatus(pid) {
    try { return readFileSync(`/proc/${pid}/status`, "utf8") } catch { return null }
  },
  readCwd(pid) {
    try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
  },
  readComm(pid) {
    try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim() } catch { return null }
  },
  listFds(pid) {
    try {
      return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
        try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)] } catch { return [] }
      })
    } catch { return [] }
  },
}

function parsePpid(status: string): number | null {
  const m = status.match(/^PPid:\s*(\d+)/m)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

export type ResolveOpts = {
  fs?: ProcFs
  startPid?: number
  targetComm?: string
  maxDepth?: number
}

// Walk up from startPid (default process.pid) looking for the nearest ancestor
// whose `comm` matches targetComm (default "claude"). Return that ancestor's
// cwd. Fall back to process.cwd() if nothing matches within maxDepth hops.
export function resolveClaudeCwd(opts: ResolveOpts = {}): string {
  const pid = findClaudePid(opts)
  if (pid !== null) {
    const cwd = (opts.fs ?? realProcFs).readCwd(pid)
    if (cwd) return cwd
  }
  return process.cwd()
}

// Same walk as resolveClaudeCwd but returns the matched PID instead of its
// cwd. Used to look for the claude process's open session jsonl.
export function findClaudePid(opts: ResolveOpts = {}): number | null {
  const fs = opts.fs ?? realProcFs
  const target = opts.targetComm ?? "claude"
  const maxDepth = opts.maxDepth ?? 8
  let pid = opts.startPid ?? process.pid
  for (let i = 0; i < maxDepth; i++) {
    const status = fs.readStatus(pid)
    if (!status) return null
    const ppid = parsePpid(status)
    if (!ppid || ppid === 1) return null
    const comm = fs.readComm(ppid)
    if (comm === target) return ppid
    pid = ppid
  }
  return null
}

// Claude Code's resume-stable identity is the **jsonl filename** in
//   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
// where cwd-slug is the cwd with `/` replaced by `-`. `claude --continue`
// and `claude --resume <id>` both extend an existing jsonl; fresh `claude`
// creates a new one. The UUID in the filename is stable across restarts
// (same conversation → same file). The per-process file at
// `~/.claude/sessions/<pid>.json` looks plausible but actually carries a
// FRESH UUID every invocation (empirically verified: claude --continue
// rewrites this file with a new sessionId even though the jsonl is reused).
//
// Strategy: compute the cwd-slug from the claude ancestor's cwd, list
// *.jsonl in the project dir, and pick the one with the newest mtime IF
// that mtime is recent enough to be plausibly the active session (otherwise
// we'd latch onto a stale previous session when launched as a brand-new
// claude). "Recent enough" = within `freshnessMs` of now (default 10s) —
// Claude writes the first event to its jsonl within a second or two of
// spawning the MCP child.
//
// Returns null for fresh `claude` (newest jsonl too old) or when we can't
// locate the project dir.

import { readdirSync, statSync } from "fs"

export type JsonlLister = (projectDir: string) => { name: string; mtimeMs: number }[]

function defaultListProjectJsonls(projectDir: string): { name: string; mtimeMs: number }[] {
  try {
    return readdirSync(projectDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => {
        try { return { name: n, mtimeMs: statSync(`${projectDir}/${n}`).mtimeMs } } catch { return null }
      })
      .filter((x): x is { name: string; mtimeMs: number } => x !== null)
  } catch { return [] }
}

// Claude Code's project-dir slug: replace `/` AND `.` with `-`. The `.`
// transform tripped us up in deployment — `/data00/home/xiaolong.835/…`
// becomes `-data00-home-xiaolong-835-…` (not `-data00-home-xiaolong.835-…`),
// so missing the dot transform made shim's probe look in a non-existent
// dir for fresh feishu-spawn sessions (and silently fall through to
// register-null / hard-exit). Any other chars Claude translates should be
// added here when we spot them in the wild.
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/[./]/g, "-")
}

export type SessionUuidOpts = ResolveOpts & {
  claudeHome?: string          // default: $HOME/.claude
  now?: number                 // injected for tests
  freshnessMs?: number         // default 10_000
  listJsonls?: JsonlLister
}

export function findClaudeSessionUuid(opts: SessionUuidOpts = {}): string | null {
  const pid = findClaudePid(opts)
  if (pid === null) return null
  const fs = opts.fs ?? realProcFs
  const cwd = fs.readCwd(pid)
  if (!cwd) return null
  const home = opts.claudeHome ?? `${process.env.HOME ?? ""}/.claude`
  const projectDir = `${home}/projects/${cwdToProjectSlug(cwd)}`
  const list = (opts.listJsonls ?? defaultListProjectJsonls)(projectDir)
  if (list.length === 0) return null
  const newest = list.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b))
  const now = opts.now ?? Date.now()
  const freshnessMs = opts.freshnessMs ?? 10_000
  if (now - newest.mtimeMs > freshnessMs) return null
  // Filename is <uuid>.jsonl — strip the extension.
  const base = newest.name.replace(/\.jsonl$/, "")
  if (!/^[0-9a-f-]{20,}$/i.test(base)) return null
  return base
}

// Daemon-side helper: spawn a claude in `cwd`, then poll the project jsonl
// directory for a *newly-created* jsonl file. The file's basename is the
// session UUID — that's Claude Code's authoritative identity (stable across
// --continue / --resume). This is how daemon converts "I just ran `tmux
// new-window claude`" into a real session_id WITHOUT needing the shim to
// register first (the shim will also probe the same jsonl and arrive at the
// same UUID — we just don't want to wait on that round-trip before saving
// the thread_id ↔ session_id mapping).
export type PollNewUuidOpts = {
  claudeHome?: string
  timeoutMs?: number           // default 10_000
  pollIntervalMs?: number      // default 200
  listJsonls?: JsonlLister
  now?: () => number           // test injection
  sleep?: (ms: number) => Promise<void>  // test injection
}
export async function pollForNewClaudeSessionUuid(
  cwd: string,
  opts: PollNewUuidOpts = {},
): Promise<string | null> {
  const home = opts.claudeHome ?? `${process.env.HOME ?? ""}/.claude`
  const projectDir = `${home}/projects/${cwdToProjectSlug(cwd)}`
  const list = opts.listJsonls ?? defaultListProjectJsonls
  const before = new Set(list(projectDir).map((x) => x.name))
  const timeoutMs = opts.timeoutMs ?? 10_000
  const interval = opts.pollIntervalMs ?? 200
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const current = list(projectDir)
    for (const entry of current) {
      if (before.has(entry.name)) continue
      const base = entry.name.replace(/\.jsonl$/, "")
      if (!/^[0-9a-f-]{20,}$/i.test(base)) continue
      return base
    }
    await sleep(interval)
  }
  return null
}
