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
// (same conversation → same file).
//
// Each running claude also writes `~/.claude/sessions/<pid>.json` containing
// a `sessionId` field. For a FRESH spawn, that sessionId matches the jsonl
// filename (1:1). For a `claude --continue` / `--resume`, the pid-json gets
// a fresh throwaway UUID while the jsonl keeps its stable name — so the two
// can differ. Strategy therefore has two paths:
//
//   (a) Fast path: read my claude parent's pid-json. If `<uuid>.jsonl` with
//       that uuid exists in the project dir → return it. This is a FRESH
//       spawn and it disambiguates the concurrent-spawn race (two claudes
//       in the same cwd must not pick each other's jsonl just because it's
//       "newest within 10s").
//   (b) Slow path (resume): pid-json's uuid doesn't have a jsonl, or
//       pid-json isn't written yet. Fall back to "newest-mtime within
//       freshnessMs" — but REMOVE jsonls whose basename is claimed by
//       another live claude's pid-json. That eliminates the race for the
//       resume case too (we'll never pick a sibling claude's jsonl).
//
// Returns null when nothing plausible is found (caller retries).

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

export type PidSessionReader = (pid: number, claudeHome: string) => string | null

function defaultReadPidSessionId(pid: number, claudeHome: string): string | null {
  try {
    const raw = readFileSync(`${claudeHome}/sessions/${pid}.json`, "utf8")
    const parsed = JSON.parse(raw) as { sessionId?: unknown }
    return typeof parsed.sessionId === "string" ? parsed.sessionId : null
  } catch { return null }
}

export type ClaimedIdsLister = (claudeHome: string, excludePid: number, fs: ProcFs) => Set<string>

function defaultListClaimedSessionIds(
  claudeHome: string,
  excludePid: number,
  fs: ProcFs,
): Set<string> {
  const out = new Set<string>()
  try {
    for (const name of readdirSync(`${claudeHome}/sessions`)) {
      const m = name.match(/^(\d+)\.json$/)
      if (!m) continue
      const pid = Number(m[1])
      if (!Number.isFinite(pid) || pid === excludePid) continue
      // Skip stale pid-jsons from dead claudes — otherwise we'd filter jsonls
      // whose owner exited ages ago, and the resume-path fallback would
      // come back empty. ProcFs.readComm is the liveness check (real fs
      // backs it with /proc/<pid>/comm; tests inject their own).
      if (fs.readComm(pid) === null) continue
      const sid = defaultReadPidSessionId(pid, claudeHome)
      if (sid) out.add(sid)
    }
  } catch { /* sessions dir missing — fine */ }
  return out
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

const UUID_RE = /^[0-9a-f-]{20,}$/i

export type SessionUuidOpts = ResolveOpts & {
  claudeHome?: string          // default: $HOME/.claude
  now?: number                 // injected for tests
  freshnessMs?: number         // default 10_000
  listJsonls?: JsonlLister
  readPidSessionId?: PidSessionReader
  listClaimedSessionIds?: ClaimedIdsLister
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
  const now = opts.now ?? Date.now()
  const freshnessMs = opts.freshnessMs ?? 10_000
  const readPidSessionId = opts.readPidSessionId ?? defaultReadPidSessionId

  // Fast path: pid-json's sessionId pinpoints exactly which jsonl belongs
  // to MY claude. Doesn't care about other concurrent claudes writing
  // their own jsonls. If pid-json hasn't been written yet (first ~100ms
  // of claude startup), this returns null and we fall through.
  const myCandidate = readPidSessionId(pid, home)
  if (myCandidate && UUID_RE.test(myCandidate)) {
    const hit = list.find((j) => j.name === `${myCandidate}.jsonl`)
    if (hit && now - hit.mtimeMs <= freshnessMs) return myCandidate
  }

  // Resume path: pid-json's sessionId is a fresh throwaway; the jsonl
  // actually being written has a DIFFERENT name. Pick the newest jsonl,
  // but exclude ones claimed by other live claudes so a concurrent
  // sibling's jsonl can't slip in.
  if (list.length === 0) return null
  const listClaimed = opts.listClaimedSessionIds ?? defaultListClaimedSessionIds
  const claimed = listClaimed(home, pid, fs)
  const candidates = list.filter((j) => {
    const base = j.name.replace(/\.jsonl$/, "")
    if (!UUID_RE.test(base)) return false
    if (now - j.mtimeMs > freshnessMs) return false
    if (claimed.has(base)) return false
    return true
  })
  if (candidates.length === 0) return null
  const newest = candidates.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b))
  return newest.name.replace(/\.jsonl$/, "")
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
