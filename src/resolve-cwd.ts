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

// Claude Code writes per-process session metadata to
//   ~/.claude/sessions/<claude_pid>.json
// on startup, containing {"pid":..., "sessionId":"<uuid>", "cwd":"...", ...}.
// The `sessionId` is stable across `claude --resume` (same conversation →
// same UUID), which is exactly the key we want for thread routing.
// Reading this file is cheap and reliable, unlike scanning /proc/<pid>/fd for
// open jsonl handles (Claude doesn't keep the jsonl open between writes, so
// fd inspection almost always misses it).
//
// Returns null when we can't find a claude ancestor, can't read the session
// file, or the file hasn't been written yet (very early startup — Claude Code
// usually writes it before spawning MCP children, but we tolerate the race).
export type SessionFileReader = (pid: number) => string | null
export function findClaudeSessionUuid(
  opts: ResolveOpts & { readSessionFile?: SessionFileReader } = {},
): string | null {
  const pid = findClaudePid(opts)
  if (pid === null) return null
  const readFn = opts.readSessionFile ?? defaultReadSessionFile
  const raw = readFn(pid)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { sessionId?: string }
    if (parsed.sessionId && /^[0-9a-f-]{20,}$/i.test(parsed.sessionId)) {
      return parsed.sessionId
    }
  } catch { /* fallthrough */ }
  return null
}

function defaultReadSessionFile(pid: number): string | null {
  // Use the *claude user's* home, not whatever $HOME the shim inherits. In
  // the normal install they're the same, but the tests inject a different
  // home via opts.readSessionFile anyway, so this stays simple.
  const home = process.env.HOME ?? ""
  try {
    return require("fs").readFileSync(`${home}/.claude/sessions/${pid}.json`, "utf8")
  } catch {
    return null
  }
}
