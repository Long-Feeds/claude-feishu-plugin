import type { ThreadStore, ThreadRecord } from "./threads"
import type { DaemonState } from "./daemon-state"
import type { FeishuApi } from "./feishu-api"

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
    // Already swept once: runIdleSweep flips status→inactive but doesn't
    // advance last_message_at, so without this filter the next tick would
    // re-select the same record and re-post the hibernate notice every
    // FEISHU_IDLE_SWEEP_HOURS forever. resumeSession flips it back to
    // active when the user returns, which re-arms eligibility legitimately.
    if (rec.status === "inactive") continue
    if (now - rec.last_message_at <= idleMs) continue
    out.push({ ...rec, thread_id: tid })
  }
  out.sort((a, b) => a.last_message_at - b.last_message_at)
  return out.slice(0, max)
}

const HIBERNATE_NOTICE = "🛌 会话空闲 24 小时，已休眠。发新消息会自动恢复上下文。"

export type IdleSweepDeps = {
  threads: ThreadStore
  saveThreads: (store: ThreadStore) => void
  feishuApi: FeishuApi | null
  killTmuxWindow: (session: string, windowName: string) => Promise<void>
  daemonState: DaemonState
  tmuxSession: string
  now: number
  idleMs: number
  max: number
  log: (msg: string) => void
}

// Execute one sweep tick. Per candidate, in order:
//   1. Post a hibernate notice in the thread (best-effort; notify failure
//      must not block kill).
//   2. Remove the in-memory SessionEntry so any concurrent inbound routes
//      to `resumeSession` rather than send-keysing a dying pane.
//   3. tmux kill-window — kill-window failure must not block the state
//      flip (window may already be gone).
//   4. Flip status to inactive in memory.
// Batched saveThreads at the end keeps disk writes to one per tick.
export async function runIdleSweep(deps: IdleSweepDeps): Promise<{ killed: string[] }> {
  const selected = selectIdleFeishuThreads(deps.threads, deps.now, deps.idleMs, deps.max)
  const killed: string[] = []
  for (const t of selected) {
    const windowName = t.tmux_window_name ?? `fb:${t.session_id.slice(0, 8)}`

    if (deps.feishuApi) {
      try {
        await deps.feishuApi.sendInThread({
          root_message_id: t.root_message_id,
          text: HIBERNATE_NOTICE,
          format: "markdown",
          seed_thread: false,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.log(`idle-sweep: notify failed for thread=${t.thread_id}: ${msg}`)
      }
    }

    deps.daemonState.remove(t.session_id)

    try {
      await deps.killTmuxWindow(deps.tmuxSession, windowName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log(`idle-sweep: kill-window failed for ${windowName}: ${msg}`)
    }

    const rec = deps.threads.threads[t.thread_id]
    if (rec) rec.status = "inactive"
    killed.push(t.thread_id)
  }

  if (killed.length > 0) deps.saveThreads(deps.threads)
  return { killed }
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
