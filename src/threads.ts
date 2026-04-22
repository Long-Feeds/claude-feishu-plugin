import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export type ThreadOrigin = "terminal" | "feishu"

export type ThreadRecord = {
  session_id: string
  claude_session_uuid?: string
  chat_id: string
  root_message_id: string
  cwd: string
  origin: ThreadOrigin
  status: "active" | "inactive" | "closed"
  last_active_at: number
  last_message_at: number
  spawn_env?: Record<string, string>
}

export type PendingRoot = {
  chat_id: string
  root_message_id: string
  created_at: number
}

export type ThreadStore = {
  version: 1
  threads: Record<string, ThreadRecord>
  // session_id → announce-root info. Populated when daemon posts a terminal
  // auto-announce; consumed on the first MCP reply (which upgrades to a real
  // thread binding under `threads`). Persisted so daemon restarts don't
  // drop the announce state and re-announce on shim reconnect.
  pendingRoots?: Record<string, PendingRoot>
}

// Back-compat: the `origin` field previously stored legacy shorthand values
// ("X-b" = terminal-started, "Y-b" = feishu-spawned). Existing threads.json
// files still carry those values; normalise on read so callers only ever see
// the new names. Rewrite happens on next save.
function migrateOrigin(raw: unknown): ThreadOrigin {
  if (raw === "terminal" || raw === "feishu") return raw
  if (raw === "X-b") return "terminal"
  if (raw === "Y-b") return "feishu"
  return "feishu" // conservative fallback
}

export function loadThreads(file: string): ThreadStore {
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as ThreadStore
    if (!parsed || typeof parsed !== "object" || !parsed.threads) {
      return { version: 1, threads: {} }
    }
    for (const rec of Object.values(parsed.threads)) {
      if (rec) rec.origin = migrateOrigin((rec as any).origin)
    }
    return {
      version: 1,
      threads: parsed.threads,
      pendingRoots: parsed.pendingRoots ?? {},
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { version: 1, threads: {}, pendingRoots: {} }
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return { version: 1, threads: {}, pendingRoots: {} }
  }
}

export function saveThreads(file: string, store: ThreadStore): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

export function upsertThread(store: ThreadStore, thread_id: string, rec: ThreadRecord): void {
  store.threads[thread_id] = rec
}

export function findByThreadId(store: ThreadStore, thread_id: string): ThreadRecord | undefined {
  return store.threads[thread_id]
}

export function findBySessionId(
  store: ThreadStore,
  session_id: string,
): (ThreadRecord & { thread_id: string }) | undefined {
  for (const [tid, rec] of Object.entries(store.threads)) {
    if (rec.session_id === session_id) return { ...rec, thread_id: tid }
  }
  return undefined
}

export function markInactive(store: ThreadStore, session_id: string): void {
  const found = findBySessionId(store, session_id)
  if (!found) return
  store.threads[found.thread_id]!.status = "inactive"
  store.threads[found.thread_id]!.last_active_at = Date.now()
}

export function markActive(store: ThreadStore, session_id: string): void {
  const found = findBySessionId(store, session_id)
  if (!found) return
  if (found.status === "closed") return  // terminal; don't resurrect
  store.threads[found.thread_id]!.status = "active"
  store.threads[found.thread_id]!.last_active_at = Date.now()
}

export function close(store: ThreadStore, thread_id: string): void {
  const rec = store.threads[thread_id]
  if (rec) rec.status = "closed"
}

// Find a terminal-origin thread record bound to `cwd`, newest first, skipping
// closed threads. Returns undefined if there's no prior binding. Used by
// handleRegister to reuse an existing session_id when `claude --resume`
// respawns the shim — keeps the feishu thread continuous across restarts.
export function findRecentTerminalThreadForCwd(
  store: ThreadStore,
  cwd: string,
): (ThreadRecord & { thread_id: string }) | undefined {
  let best: (ThreadRecord & { thread_id: string }) | undefined
  for (const [tid, rec] of Object.entries(store.threads)) {
    if (rec.origin !== "terminal") continue
    if (rec.status === "closed") continue
    if (rec.cwd !== cwd) continue
    if (!best || rec.last_active_at > best.last_active_at) {
      best = { ...rec, thread_id: tid }
    }
  }
  return best
}

export function pruneInactive(store: ThreadStore, olderThanMs: number): string[] {
  // Drops inactive threads older than the cutoff, but keeps:
  //   - active (live sessions)
  //   - closed (explicit user archive — don't silently erase intent)
  //   - inactive-with-claude_session_uuid (resumable — throwing these away
  //     would permanently lose the ability to resume that conversation)
  // Returns pruned thread_ids so the caller can log them.
  const cutoff = Date.now() - olderThanMs
  const pruned: string[] = []
  for (const [tid, rec] of Object.entries(store.threads)) {
    if (rec.status !== "inactive") continue
    if (rec.claude_session_uuid) continue
    if (rec.last_active_at > cutoff) continue
    delete store.threads[tid]
    pruned.push(tid)
  }
  return pruned
}
