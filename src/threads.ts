import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export type ThreadRecord = {
  session_id: string
  claude_session_uuid?: string
  chat_id: string
  root_message_id: string
  cwd: string
  origin: "X-b" | "Y-b"
  status: "active" | "inactive" | "closed"
  last_active_at: number
  last_message_at: number
  spawn_env?: Record<string, string>
}

export type ThreadStore = {
  version: 1
  threads: Record<string, ThreadRecord>
}

export function loadThreads(file: string): ThreadStore {
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as ThreadStore
    if (!parsed || typeof parsed !== "object" || !parsed.threads) {
      return { version: 1, threads: {} }
    }
    return { version: 1, threads: parsed.threads }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { version: 1, threads: {} }
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return { version: 1, threads: {} }
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
  store.threads[found.thread_id]!.status = "active"
  store.threads[found.thread_id]!.last_active_at = Date.now()
}

export function close(store: ThreadStore, thread_id: string): void {
  const rec = store.threads[thread_id]
  if (rec) rec.status = "closed"
}
