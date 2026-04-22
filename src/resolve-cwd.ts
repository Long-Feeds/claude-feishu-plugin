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

// Claude Code writes its session log to
//   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
// and keeps the file open for the life of the session. We inspect the claude
// process's open-fd list for any `.jsonl` under `~/.claude/projects/` and
// return the UUID from the filename. This gives us a stable session key that
// survives `claude --resume` (same UUID = same jsonl = same thread binding),
// unlike our own in-memory `sessionId` cache which is lost on process restart.
// Returns null when claude hasn't opened its jsonl yet (fresh `claude` before
// the first turn writes an event).
export function findClaudeSessionUuid(opts: ResolveOpts = {}): string | null {
  const fs = opts.fs ?? realProcFs
  if (!fs.listFds) return null
  const pid = findClaudePid(opts)
  if (pid === null) return null
  for (const path of fs.listFds(pid)) {
    // Match absolute paths like /home/<user>/.claude/projects/<slug>/<uuid>.jsonl
    const m = /\/\.claude\/projects\/[^/]+\/([0-9a-f-]{20,})\.jsonl(\s*\(deleted\))?$/i.exec(path)
    if (m && m[1]) return m[1]
  }
  return null
}
