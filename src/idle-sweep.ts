import type { ThreadStore, ThreadRecord } from "./threads"

// Pure: picks at most `max` feishu-origin, non-closed threads whose last
// message is older than `idleMs`. Sorted oldest-first so the safety cap
// consistently evicts the most stale entries under backlog.
export function selectIdleFeishuThreads(
  store: ThreadStore,
  now: number,
  idleMs: number,
  max: number,
): Array<ThreadRecord & { thread_id: string }> {
  const out: Array<ThreadRecord & { thread_id: string }> = []
  for (const [tid, rec] of Object.entries(store.threads)) {
    if (rec.origin !== "feishu") continue
    if (rec.status === "closed") continue
    if (now - rec.last_message_at <= idleMs) continue
    out.push({ ...rec, thread_id: tid })
  }
  out.sort((a, b) => a.last_message_at - b.last_message_at)
  return out.slice(0, max)
}

// Scheduler delay in ms. Returns 0 when the feature is disabled (caller
// must treat 0 as "do not schedule").
export function sweepIntervalMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number {
  if (env.FEISHU_IDLE_KILL_DISABLE === "1") return 0
  const raw = env.FEISHU_IDLE_SWEEP_HOURS
  const hours = raw === undefined ? 12 : Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return 12 * 3600_000
  return hours * 3600_000
}
