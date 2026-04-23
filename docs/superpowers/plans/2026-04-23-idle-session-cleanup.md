# Idle feishu-spawn session cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-reclaim claude processes + tmux windows from feishu-spawn sessions that have been idle for >24 h, preserving the `threads.json` binding so new messages transparently `claude --resume`.

**Architecture:** A 12 h timer inside the daemon invokes a pure selector + an async executor (both in a new `src/idle-sweep.ts`). Selector picks feishu-origin threads whose `last_message_at` is older than 24 h (cap 20 oldest-first). Executor, per thread: posts a hibernate notification, removes from `DaemonState`, `tmux kill-window`s the recorded pane, flips `threads.json` status to `inactive`. A schema field `tmux_window_name` is added to `ThreadRecord` so cleanup works after the shim has already disconnected; legacy records fall back to `fb:<session_id[:8]>`.

**Tech Stack:** TypeScript / Bun (existing daemon); `bun:test` for unit + integration; no new dependencies.

---

## File Structure

**New files:**
- `src/idle-sweep.ts` — pure selector, env parser, async executor
- `tests/idle-sweep.test.ts` — unit tests for selector, env parser, executor
- `tests/integration/idle-sweep.test.ts` — integration test: real `threads.json` on disk + fake tmux

**Modified files:**
- `src/threads.ts` — add `tmux_window_name?: string` to `ThreadRecord`
- `tests/threads.test.ts` — schema roundtrip assertion
- `src/daemon.ts` — (a) populate `tmux_window_name` at 3 `upsertThread` sites; (b) add `runIdleSweepOnce` + `scheduleIdleSweep` + `killTmuxWindow`; (c) start the scheduler in `Daemon.start`
- `tests/daemon-routing.test.ts` — wiring test: stale feishu thread is killed; terminal thread is not; `tmux_window_name` gets populated on register

---

## Task 1: Add `tmux_window_name` field to `ThreadRecord`

**Files:**
- Modify: `src/threads.ts`
- Modify: `tests/threads.test.ts`

- [ ] **Step 1: Write failing schema-roundtrip test** (`tests/threads.test.ts`, append at end-of-file)

```ts
test("ThreadRecord preserves tmux_window_name across save/load", () => {
  const store = loadThreads(file)
  upsertThread(store, "t_wn", {
    session_id: "S_WN", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "feishu", status: "active",
    last_active_at: 1, last_message_at: 1,
    tmux_window_name: "fb:test-abc123",
  })
  saveThreads(file, store)
  const back = loadThreads(file)
  expect(back.threads["t_wn"]!.tmux_window_name).toBe("fb:test-abc123")
})
```

- [ ] **Step 2: Run test — expect TypeScript error (field not in type)**

Run: `bun test tests/threads.test.ts 2>&1 | tail -20`
Expected: compile error like `Object literal may only specify known properties, and 'tmux_window_name' does not exist in type 'ThreadRecord'`.

- [ ] **Step 3: Add the field to the type**

Edit `src/threads.ts`. In the `ThreadRecord` type, insert after `last_message_at: number`:

```ts
  // tmux window name owning the claude pane for this thread, reported by
  // the shim at register time. Recorded here so the idle sweeper can
  // `tmux kill-window` the correct pane even after the shim has
  // disconnected (SessionEntry is gone by then). Legacy records without
  // this field fall back to `fb:<session_id[:8]>` in the sweeper.
  tmux_window_name?: string
```

- [ ] **Step 4: Run test — expect pass**

Run: `bun test tests/threads.test.ts 2>&1 | tail -5`
Expected: all existing tests + the new one pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/threads.ts tests/threads.test.ts
git commit -m "ThreadRecord: optional tmux_window_name for post-disconnect window lookup"
```

---

## Task 2: Pure selector + env parser in `src/idle-sweep.ts`

**Files:**
- Create: `src/idle-sweep.ts`
- Create: `tests/idle-sweep.test.ts`

- [ ] **Step 1: Write failing selector tests** (new file `tests/idle-sweep.test.ts`)

```ts
import { test, expect } from "bun:test"
import { selectIdleFeishuThreads, sweepIntervalMs } from "../src/idle-sweep"
import type { ThreadStore } from "../src/threads"

function store(threads: Record<string, any>): ThreadStore {
  return { version: 1, threads, pendingRoots: {} }
}

const day = 24 * 3600_000

test("selectIdleFeishuThreads returns feishu threads whose last_message_at is older than idleMs", () => {
  const now = 1_800_000_000_000
  const s = store({
    t_stale: { session_id: "S1", chat_id: "c", root_message_id: "m", cwd: "/w",
               origin: "feishu", status: "active",
               last_active_at: now - 2 * day, last_message_at: now - 2 * day },
    t_fresh: { session_id: "S2", chat_id: "c", root_message_id: "m", cwd: "/w",
               origin: "feishu", status: "active",
               last_active_at: now - 3600_000, last_message_at: now - 3600_000 },
  })
  const out = selectIdleFeishuThreads(s, now, day, 20)
  expect(out.map((x) => x.thread_id)).toEqual(["t_stale"])
})

test("selectIdleFeishuThreads SKIPS origin=terminal", () => {
  const now = 1_800_000_000_000
  const s = store({
    t_term: { session_id: "S3", chat_id: "c", root_message_id: "m", cwd: "/w",
              origin: "terminal", status: "active",
              last_active_at: now - 5 * day, last_message_at: now - 5 * day },
  })
  expect(selectIdleFeishuThreads(s, now, day, 20)).toEqual([])
})

test("selectIdleFeishuThreads SKIPS status=closed even if very stale", () => {
  const now = 1_800_000_000_000
  const s = store({
    t_closed: { session_id: "S4", chat_id: "c", root_message_id: "m", cwd: "/w",
                origin: "feishu", status: "closed",
                last_active_at: now - 30 * day, last_message_at: now - 30 * day },
  })
  expect(selectIdleFeishuThreads(s, now, day, 20)).toEqual([])
})

test("selectIdleFeishuThreads boundary: exactly idleMs old is NOT selected", () => {
  const now = 1_800_000_000_000
  const s = store({
    t_edge: { session_id: "S5", chat_id: "c", root_message_id: "m", cwd: "/w",
              origin: "feishu", status: "active",
              last_active_at: now - day, last_message_at: now - day },
  })
  expect(selectIdleFeishuThreads(s, now, day, 20)).toEqual([])
})

test("selectIdleFeishuThreads respects max, oldest first", () => {
  const now = 1_800_000_000_000
  const threads: Record<string, any> = {}
  for (let i = 0; i < 25; i++) {
    threads[`t${i}`] = {
      session_id: `S${i}`, chat_id: "c", root_message_id: "m", cwd: "/w",
      origin: "feishu", status: "active",
      last_active_at: now - (2 * day + i * 1000),
      last_message_at: now - (2 * day + i * 1000),
    }
  }
  const out = selectIdleFeishuThreads(store(threads), now, day, 20)
  expect(out.length).toBe(20)
  // Newest candidate last_message_at = now - 2d - 0ms (t0) → t0 has the LATEST
  // last_message_at among candidates. Oldest-first sort puts t24 (most stale)
  // first. Safety cap drops the 5 least stale ones (t0..t4).
  expect(out[0]!.thread_id).toBe("t24")
  expect(out[19]!.thread_id).toBe("t5")
})

test("sweepIntervalMs defaults to 12h", () => {
  expect(sweepIntervalMs({})).toBe(12 * 3600_000)
})

test("sweepIntervalMs honours FEISHU_IDLE_SWEEP_HOURS", () => {
  expect(sweepIntervalMs({ FEISHU_IDLE_SWEEP_HOURS: "6" })).toBe(6 * 3600_000)
})

test("sweepIntervalMs returns 0 when FEISHU_IDLE_KILL_DISABLE=1 (scheduler opts out)", () => {
  expect(sweepIntervalMs({ FEISHU_IDLE_KILL_DISABLE: "1" })).toBe(0)
})

test("sweepIntervalMs falls back to default on malformed input", () => {
  expect(sweepIntervalMs({ FEISHU_IDLE_SWEEP_HOURS: "nope" })).toBe(12 * 3600_000)
  expect(sweepIntervalMs({ FEISHU_IDLE_SWEEP_HOURS: "-1" })).toBe(12 * 3600_000)
})
```

- [ ] **Step 2: Run tests — expect module-not-found failures**

Run: `bun test tests/idle-sweep.test.ts 2>&1 | tail -5`
Expected: `Cannot find module '../src/idle-sweep'` or similar.

- [ ] **Step 3: Create `src/idle-sweep.ts` with the selector + env parser**

```ts
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
export function sweepIntervalMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  if (env.FEISHU_IDLE_KILL_DISABLE === "1") return 0
  const raw = env.FEISHU_IDLE_SWEEP_HOURS
  const hours = raw === undefined ? 12 : Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return 12 * 3600_000
  return hours * 3600_000
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/idle-sweep.test.ts 2>&1 | tail -5`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/idle-sweep.ts tests/idle-sweep.test.ts
git commit -m "idle-sweep: pure selector + env-driven interval"
```

---

## Task 3: `runIdleSweep` executor

**Files:**
- Modify: `src/idle-sweep.ts`
- Modify: `tests/idle-sweep.test.ts`

- [ ] **Step 1: Write failing executor tests** (append to `tests/idle-sweep.test.ts`)

```ts
import { runIdleSweep } from "../src/idle-sweep"
import { DaemonState } from "../src/daemon-state"
import type { FeishuApi } from "../src/feishu-api"
import type { Socket } from "net"

type NotifyCall = { root_message_id: string; text: string; seed_thread: boolean }
type KillCall = { session: string; windowName: string }

function fakes() {
  const notifyCalls: NotifyCall[] = []
  const killCalls: KillCall[] = []
  const logs: string[] = []
  const api: Partial<FeishuApi> = {
    sendInThread: async (args: any) => {
      notifyCalls.push({ root_message_id: args.root_message_id, text: args.text, seed_thread: args.seed_thread })
      return { message_id: "mock_msg" }
    },
  }
  const killTmuxWindow = async (session: string, windowName: string) => {
    killCalls.push({ session, windowName })
  }
  const saved: any[] = []
  const saveThreads = (s: any) => { saved.push(JSON.parse(JSON.stringify(s))) }
  const log = (msg: string) => logs.push(msg)
  const daemonState = new DaemonState()
  return { notifyCalls, killCalls, logs, api, killTmuxWindow, saved, saveThreads, log, daemonState }
}

const day = 24 * 3600_000

test("runIdleSweep: happy path — notify, state.remove, kill, flip-to-inactive, save", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const threads: any = {
    version: 1,
    threads: {
      t_stale: {
        session_id: "S_stale", chat_id: "c", root_message_id: "m_root", cwd: "/w",
        origin: "feishu", status: "active",
        last_active_at: now - 2 * day, last_message_at: now - 2 * day,
        tmux_window_name: "fb:foo-abc123",
      },
    },
    pendingRoots: {},
  }

  // Pre-populate a SessionEntry so we can observe state.remove
  const mockConn = { destroyed: true, destroy: () => {} } as unknown as Socket
  f.daemonState.register({
    session_id: "S_stale", conn: mockConn, cwd: "/w", pid: 1,
    registered_at: now, tmux_window_name: "fb:foo-abc123",
  })

  const result = await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: f.api as FeishuApi,
    killTmuxWindow: f.killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })

  expect(result.killed).toEqual(["t_stale"])
  expect(f.notifyCalls).toEqual([{
    root_message_id: "m_root",
    text: expect.stringContaining("休眠"),
    seed_thread: false,
  }])
  expect(f.killCalls).toEqual([{ session: "claude-feishu", windowName: "fb:foo-abc123" }])
  expect(f.daemonState.get("S_stale")).toBeUndefined()
  expect(threads.threads["t_stale"].status).toBe("inactive")
  expect(f.saved.length).toBe(1)
  expect(f.saved[0].threads.t_stale.status).toBe("inactive")
})

test("runIdleSweep: legacy record without tmux_window_name falls back to fb:<session_id[:8]>", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const threads: any = {
    version: 1,
    threads: {
      t_legacy: {
        session_id: "abcd1234-efgh-5678-ijkl-mnopqrstuvwx", chat_id: "c",
        root_message_id: "m_root", cwd: "/w",
        origin: "feishu", status: "active",
        last_active_at: now - 2 * day, last_message_at: now - 2 * day,
      },
    },
    pendingRoots: {},
  }
  await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: f.api as FeishuApi,
    killTmuxWindow: f.killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })
  expect(f.killCalls).toEqual([{ session: "claude-feishu", windowName: "fb:abcd1234" }])
})

test("runIdleSweep: notification failure does NOT block kill", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const api: Partial<FeishuApi> = {
    sendInThread: async () => { throw new Error("feishu api down") },
  }
  const threads: any = {
    version: 1,
    threads: {
      t_stale: {
        session_id: "S", chat_id: "c", root_message_id: "m", cwd: "/w",
        origin: "feishu", status: "active",
        last_active_at: now - 2 * day, last_message_at: now - 2 * day,
        tmux_window_name: "fb:x",
      },
    },
    pendingRoots: {},
  }
  const result = await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: api as FeishuApi,
    killTmuxWindow: f.killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })
  expect(result.killed).toEqual(["t_stale"])
  expect(f.killCalls.length).toBe(1)
  expect(threads.threads["t_stale"].status).toBe("inactive")
  expect(f.logs.some((l) => l.includes("notify failed"))).toBe(true)
})

test("runIdleSweep: kill failure does NOT block state flip", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const killTmuxWindow = async () => { throw new Error("no such window") }
  const threads: any = {
    version: 1,
    threads: {
      t_stale: {
        session_id: "S", chat_id: "c", root_message_id: "m", cwd: "/w",
        origin: "feishu", status: "active",
        last_active_at: now - 2 * day, last_message_at: now - 2 * day,
        tmux_window_name: "fb:x",
      },
    },
    pendingRoots: {},
  }
  const result = await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: f.api as FeishuApi,
    killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })
  expect(result.killed).toEqual(["t_stale"])
  expect(threads.threads["t_stale"].status).toBe("inactive")
  expect(f.logs.some((l) => l.includes("kill-window failed"))).toBe(true)
})

test("runIdleSweep: feishuApi=null works (still kills + flips)", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const threads: any = {
    version: 1,
    threads: {
      t_stale: {
        session_id: "S", chat_id: "c", root_message_id: "m", cwd: "/w",
        origin: "feishu", status: "active",
        last_active_at: now - 2 * day, last_message_at: now - 2 * day,
        tmux_window_name: "fb:x",
      },
    },
    pendingRoots: {},
  }
  const result = await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: null,
    killTmuxWindow: f.killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })
  expect(result.killed).toEqual(["t_stale"])
  expect(f.notifyCalls.length).toBe(0)
  expect(f.killCalls.length).toBe(1)
  expect(threads.threads["t_stale"].status).toBe("inactive")
})

test("runIdleSweep: no candidates → no save call, no killed", async () => {
  const now = 1_800_000_000_000
  const f = fakes()
  const threads: any = { version: 1, threads: {}, pendingRoots: {} }
  const result = await runIdleSweep({
    threads, saveThreads: f.saveThreads, feishuApi: f.api as FeishuApi,
    killTmuxWindow: f.killTmuxWindow, daemonState: f.daemonState,
    tmuxSession: "claude-feishu", now, idleMs: day, max: 20, log: f.log,
  })
  expect(result.killed).toEqual([])
  expect(f.saved.length).toBe(0)
})
```

- [ ] **Step 2: Run tests — expect failures (runIdleSweep not exported yet)**

Run: `bun test tests/idle-sweep.test.ts 2>&1 | tail -5`
Expected: `runIdleSweep` export-not-found errors on the six new tests.

- [ ] **Step 3: Implement `runIdleSweep` in `src/idle-sweep.ts`** (append to existing file)

```ts
import type { DaemonState } from "./daemon-state"
import type { FeishuApi } from "./feishu-api"

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
//   1. Post a hibernate notice in the thread (best-effort, notify failure
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
        deps.log(`idle-sweep: notify failed for thread=${t.thread_id}: ${err instanceof Error ? err.message : err}`)
      }
    }

    deps.daemonState.remove(t.session_id)

    try {
      await deps.killTmuxWindow(deps.tmuxSession, windowName)
    } catch (err) {
      deps.log(`idle-sweep: kill-window failed for ${windowName}: ${err instanceof Error ? err.message : err}`)
    }

    const rec = deps.threads.threads[t.thread_id]
    if (rec) rec.status = "inactive"
    killed.push(t.thread_id)
  }

  if (killed.length > 0) deps.saveThreads(deps.threads)
  return { killed }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/idle-sweep.test.ts 2>&1 | tail -5`
Expected: 14 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/idle-sweep.ts tests/idle-sweep.test.ts
git commit -m "idle-sweep: runIdleSweep executor with failure-resilient ordering"
```

---

## Task 4: Populate `tmux_window_name` at the 3 upsertThread sites in daemon.ts

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-routing.test.ts`

- [ ] **Step 1: Write failing wiring test** (append at end of `tests/daemon-routing.test.ts`)

```ts
test("feishu-spawn register records tmux_window_name in the thread binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]; acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0,
    defaultCwd: "/tmp/dwn-test", tmuxSession: "claude-feishu",
  })

  // Deliver an event with a thread_id so daemon uses the preExistingThreadId
  // branch (the only path that writes the thread directly at register time).
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_trigger", chat_id: "oc_test", chat_type: "group",
      message_type: "text", content: '{"text":"hi"}', create_time: "0",
      thread_id: "omt_preexisting",
    },
  } as any, "ou_bot")
  await wait(30)

  // Register from "shim" with a tmux_window_name. We bypass the real socket
  // for brevity: connect and send register frame.
  const s = connect(sock)
  await new Promise((r) => s.once("connect", () => r(null)))
  s.write(frame({
    op: "register", session_id: "fake-uuid-1234-5678-9abc-def012345678",
    pid: 1, cwd: "/tmp/dwn-test", tmux_window_name: "fb:hello-xyz123",
  } as any))
  await wait(50)

  const { loadThreads: lt } = await import("../src/threads")
  const store = lt(join(dir, "threads.json"))
  expect(store.threads["omt_preexisting"]!.tmux_window_name).toBe("fb:hello-xyz123")

  s.destroy()
  await daemon.stop()
})
```

- [ ] **Step 2: Run test — expect fail (field undefined)**

Run: `bun test tests/daemon-routing.test.ts -t "tmux_window_name in the thread binding" 2>&1 | tail -10`
Expected: `expect(received).toBe(expected)` with `received: undefined`.

- [ ] **Step 3: Update the three `upsertThread` call sites in `src/daemon.ts`**

Edit `src/daemon.ts`, site 1 (inside `handleRegister`, spawnIntent.preExistingThreadId branch — currently around line 321):

```ts
        upsertThread(this.threads, spawnIntent.preExistingThreadId, {
          session_id, chat_id: spawnIntent.event.message.chat_id,
          root_message_id: spawnIntent.event.message.message_id, cwd: msg.cwd,
          origin: "feishu", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
          ...(msg.tmux_window_name ? { tmux_window_name: msg.tmux_window_name } : {}),
        })
```

Site 2 (inside `handleReply`, `!bound && !pending && feishuRoot` branch — around line 563):

```ts
        upsertThread(this.threads, res.thread_id, {
          session_id: entry.session_id, chat_id: feishuRoot.chat_id,
          root_message_id: feishuRoot.root_message_id, cwd: entry.cwd,
          origin: "feishu", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
          ...(entry.tmux_window_name ? { tmux_window_name: entry.tmux_window_name } : {}),
        })
```

Site 3 (`!bound && pending` branch — around line 598):

```ts
        upsertThread(this.threads, res.thread_id, {
          session_id: entry.session_id, chat_id: pending.chat_id,
          root_message_id: pending.root_message_id, cwd: entry.cwd,
          origin: "terminal", status: "active",
          last_active_at: Date.now(), last_message_at: Date.now(),
          ...(entry.tmux_window_name ? { tmux_window_name: entry.tmux_window_name } : {}),
        })
```

- [ ] **Step 4: Run test — expect pass**

Run: `bun test tests/daemon-routing.test.ts -t "tmux_window_name in the thread binding" 2>&1 | tail -5`
Expected: 1 pass, 0 fail.

- [ ] **Step 5: Run the full daemon-routing suite — expect no regressions**

Run: `bun test tests/daemon-routing.test.ts 2>&1 | tail -5`
Expected: all existing tests + new one pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/daemon-routing.test.ts
git commit -m "daemon: persist tmux_window_name into ThreadRecord on bind"
```

---

## Task 5: Wire sweep scheduler + `runIdleSweepOnce` + daemon-routing test

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-routing.test.ts`

- [ ] **Step 1: Write failing wiring test** (append at end of `tests/daemon-routing.test.ts`)

```ts
test("runIdleSweepOnce kills a stale feishu thread, leaves terminal thread alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const spawnedCmds: string[][] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async () => ({ data: { message_id: "m_notif" } }),
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Pre-seed threads.json with a stale feishu thread and a stale terminal thread.
  const { saveThreads: st } = await import("../src/threads")
  const now = Date.now()
  const TWO_DAYS = 2 * 86400_000
  st(join(dir, "threads.json"), {
    version: 1,
    threads: {
      t_feishu_stale: {
        session_id: "S_FEISHU", chat_id: "oc_test", root_message_id: "m_root_f",
        cwd: "/tmp", origin: "feishu", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
        tmux_window_name: "fb:stale-abc",
      },
      t_terminal_stale: {
        session_id: "S_TERM", chat_id: "oc_hub", root_message_id: "m_root_t",
        cwd: "/tmp", origin: "terminal", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
    },
    pendingRoots: {},
  })

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    // Capture tmux commands for assertion instead of running real tmux.
    spawnOverride: async (argv) => { spawnedCmds.push(argv); return 0 },
    defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })

  const result = await daemon.runIdleSweepOnce(now)
  expect(result.killed).toEqual(["t_feishu_stale"])

  // Assert tmux kill-window captured
  const killCmd = spawnedCmds.find((a) => a[0] === "tmux" && a[1] === "kill-window")
  expect(killCmd).toBeDefined()
  expect(killCmd!.join(" ")).toContain("claude-feishu:fb:stale-abc")

  // Disk: feishu row → inactive; terminal row → untouched
  const { loadThreads: lt } = await import("../src/threads")
  const back = lt(join(dir, "threads.json"))
  expect(back.threads["t_feishu_stale"]!.status).toBe("inactive")
  expect(back.threads["t_terminal_stale"]!.status).toBe("active")

  await daemon.stop()
})
```

- [ ] **Step 2: Run test — expect `runIdleSweepOnce` not a function**

Run: `bun test tests/daemon-routing.test.ts -t "runIdleSweepOnce" 2>&1 | tail -10`
Expected: `daemon.runIdleSweepOnce is not a function`.

- [ ] **Step 3: Add the sweep scheduler + test hook + tmux kill helper to `Daemon`**

Edit `src/daemon.ts`:

3a. Add import at top (after existing imports from `./threads` / `./spawn`):

```ts
import { runIdleSweep, sweepIntervalMs } from "./idle-sweep"
```

3b. Inside `Daemon.start()` after `await cfg.wsStart()` (around line 209, right before `return d`):

```ts
    const sweepMs = sweepIntervalMs(process.env)
    if (sweepMs > 0) {
      // 10-minute warmup keeps reconnect storms (bun sync / systemctl
      // restart) from reading last_message_at as stale for still-live sessions
      // whose shims are mid-reconnect.
      const warmupMs = Number(process.env.FEISHU_IDLE_SWEEP_WARMUP_MS ?? "600000")
      const initialDelay = Number.isFinite(warmupMs) && warmupMs >= 0 ? warmupMs : 600_000
      setTimeout(() => d.scheduleIdleSweep(sweepMs), initialDelay).unref()
    }
```

3c. Add these three methods to the `Daemon` class (e.g. just before `async stop()`):

```ts
  private scheduleIdleSweep(delayMs: number): void {
    setTimeout(async () => {
      try { await this.runIdleSweepOnce(Date.now()) }
      catch (err) { process.stderr.write(`daemon: idle sweep threw ${err}\n`) }
      this.scheduleIdleSweep(delayMs)
    }, delayMs).unref()
  }

  // Exposed for tests and for one-shot operator-triggered runs. Never throws.
  async runIdleSweepOnce(now: number): Promise<{ killed: string[] }> {
    const idleHours = Number(process.env.FEISHU_IDLE_KILL_HOURS ?? "24")
    const idleMs = (Number.isFinite(idleHours) && idleHours > 0 ? idleHours : 24) * 3600_000
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
```

- [ ] **Step 4: Run the new test — expect pass**

Run: `bun test tests/daemon-routing.test.ts -t "runIdleSweepOnce" 2>&1 | tail -5`
Expected: 1 pass, 0 fail.

- [ ] **Step 5: Run full suite — expect no regressions**

Run: `bun test 2>&1 | tail -5`
Expected: all tests pass (previous 103 + Task 1/2/3/4/5 additions).

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/daemon-routing.test.ts
git commit -m "daemon: schedule idle sweep (10min warmup, 12h cadence) + runIdleSweepOnce hook"
```

---

## Task 6: Integration test — real `threads.json` on disk + fake tmux

**Files:**
- Create: `tests/integration/idle-sweep.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// Integration: seed a real threads.json on disk, run one sweep tick through
// Daemon.runIdleSweepOnce, read the file back, assert only the stale feishu
// thread got flipped and the right tmux command was invoked. Exercises the
// schema → selector → executor → disk round-trip.

import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Daemon } from "../../src/daemon"
import { FeishuApi } from "../../src/feishu-api"
import { saveAccess, defaultAccess } from "../../src/access"
import { saveThreads, loadThreads } from "../../src/threads"

test("idle sweep: feishu stale killed, fresh feishu untouched, terminal untouched, legacy fallback window name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-integ-"))
  const sock = join(dir, "daemon.sock")

  const notifyCalls: string[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (args: any) => {
          notifyCalls.push(args.path?.message_id ?? "")
          return { data: { message_id: "m_notif" } }
        },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const now = Date.now()
  const TWO_DAYS = 2 * 86400_000
  const TEN_MIN = 10 * 60_000
  saveThreads(join(dir, "threads.json"), {
    version: 1,
    threads: {
      // Stale feishu thread WITH tmux_window_name — should be killed.
      t_feishu_stale_modern: {
        session_id: "abcd1234-0000-4000-8000-000000000001", chat_id: "oc_test",
        root_message_id: "m_root_modern", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
        tmux_window_name: "fb:recent-xyz",
      },
      // Stale feishu thread WITHOUT tmux_window_name — legacy fallback.
      t_feishu_stale_legacy: {
        session_id: "legacy12-0000-4000-8000-000000000002", chat_id: "oc_test",
        root_message_id: "m_root_legacy", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
      // Fresh feishu thread — must NOT be killed.
      t_feishu_fresh: {
        session_id: "fresh001-0000-4000-8000-000000000003", chat_id: "oc_test",
        root_message_id: "m_root_fresh", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "active",
        last_active_at: now - TEN_MIN, last_message_at: now - TEN_MIN,
      },
      // Stale terminal thread — must NOT be killed (R3).
      t_terminal_stale: {
        session_id: "term0001-0000-4000-8000-000000000004", chat_id: "oc_hub",
        root_message_id: "m_root_term", cwd: "/tmp/idle-integ",
        origin: "terminal", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
    },
    pendingRoots: {},
  })

  const spawnedCmds: string[][] = []
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async (argv) => { spawnedCmds.push(argv); return 0 },
    defaultCwd: "/tmp/idle-integ", tmuxSession: "claude-feishu",
  })

  const result = await daemon.runIdleSweepOnce(now)

  // Two feishu threads killed in order of last_message_at (both equal here,
  // so any order is acceptable — assert set membership).
  expect(result.killed.sort()).toEqual(["t_feishu_stale_legacy", "t_feishu_stale_modern"].sort())

  // Two notifications sent (to each stale feishu root)
  expect(notifyCalls.sort()).toEqual(["m_root_legacy", "m_root_modern"].sort())

  // Two kill-window invocations with correct target strings
  const kills = spawnedCmds
    .filter((a) => a[0] === "tmux" && a[1] === "kill-window")
    .map((a) => a[3]) // argv: ["tmux","kill-window","-t","<session>:<name>"]
  expect(kills.sort()).toEqual([
    "claude-feishu:fb:legacy12",       // fallback fb:<session_id[:8]>
    "claude-feishu:fb:recent-xyz",     // recorded tmux_window_name
  ].sort())

  // Disk round-trip
  const back = loadThreads(join(dir, "threads.json"))
  expect(back.threads["t_feishu_stale_modern"]!.status).toBe("inactive")
  expect(back.threads["t_feishu_stale_legacy"]!.status).toBe("inactive")
  expect(back.threads["t_feishu_fresh"]!.status).toBe("active")
  expect(back.threads["t_terminal_stale"]!.status).toBe("active")

  await daemon.stop()
})
```

- [ ] **Step 2: Run integration test — expect pass**

Run: `bun test tests/integration/idle-sweep.test.ts 2>&1 | tail -5`
Expected: 1 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/idle-sweep.test.ts
git commit -m "integration: idle-sweep end-to-end through real threads.json"
```

---

## Task 7: Full verify + deploy sync

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `bun test 2>&1 | tail -5`
Expected: all tests pass. Count should be previous (~105) + **~14** from this plan.

- [ ] **Step 2: Lint / type check sanity**

Run: `bun run --silent tsc --noEmit 2>&1 | head -20` (if the project has a tsconfig — check `ls tsconfig.json`)
Expected: no new type errors. If no tsconfig, skip this step.

- [ ] **Step 3: Sync to plugin cache + restart daemon**

Run: `bun sync 2>&1 | tail -5`
Expected: rsync output (quiet under `-a`) followed by systemd restart with no error. The `package.json` `sync` script handles all three mirror targets + `systemctl --user restart claude-feishu`.

- [ ] **Step 4: Verify the scheduler armed at boot**

Run: `journalctl --user -u claude-feishu --since "30 seconds ago" -o cat 2>&1 | grep -iE "WebSocket connected|daemon: (fatal|idle sweep)" | tail -10`
Expected: `daemon: WebSocket connected` present (daemon healthy). No `fatal` lines. No `idle sweep` lines yet (warmup = 10 min).

- [ ] **Step 5: Trigger a one-shot sweep via env override for live validation**

This validates the end-to-end against real tmux and real Feishu. Short-circuit the 10-min warmup by restarting with `FEISHU_IDLE_SWEEP_WARMUP_MS=5000`. But we don't want to actually kill active sessions during verification — instead, restart with `FEISHU_IDLE_KILL_HOURS=1000` (nothing will match) and confirm the scheduler fires cleanly with zero matches:

```bash
sudo -u $USER systemctl --user set-environment FEISHU_IDLE_SWEEP_WARMUP_MS=5000
sudo -u $USER systemctl --user set-environment FEISHU_IDLE_KILL_HOURS=1000
systemctl --user restart claude-feishu
# wait ~15s (5s warmup + cushion)
journalctl --user -u claude-feishu --since "20 seconds ago" -o cat | grep -E "idle sweep"
# expected: no output (zero matches → no "processed N" line)
# scheduler armed cleanly — restart with defaults:
systemctl --user unset-environment FEISHU_IDLE_SWEEP_WARMUP_MS FEISHU_IDLE_KILL_HOURS
systemctl --user restart claude-feishu
```

Expected: daemon stays healthy across both restarts; no error lines.

- [ ] **Step 6: Commit any final touch-ups + push**

If any follow-up polish was needed during verification, commit it. Otherwise:

```bash
git log --oneline origin/feat/multi-session-bridge..HEAD
# expected: 6 commits from Tasks 1-6
git push
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task(s) |
|---|---|
| R1 (24 h threshold) | Task 2 (selector edge-case), Task 5 (daemon reads env) |
| R2 (10 min warmup, 12 h cadence) | Task 5 step 3b (warmup), Task 2 (sweepIntervalMs) |
| R3 (feishu only, not closed) | Task 2 (selector skip tests), Task 5 (terminal untouched) |
| R4 (notify → remove → kill → flip) | Task 3 (ordering), Task 6 (disk round-trip) |
| R5 (resume path unaffected) | Task 5 asserts terminal untouched; existing `resumeSession` tests unchanged |
| R6 (cap 20) | Task 2 (cap + oldest-first test) |
| R7 (`FEISHU_IDLE_KILL_DISABLE`) | Task 2 (`sweepIntervalMs` returns 0); Task 5 step 3b (no schedule when 0) |
| R8 (failure resilience) | Task 3 (notify-fail test, kill-fail test) |
| Schema: `tmux_window_name` | Task 1 (type), Task 4 (population) |
| Integration test | Task 6 |

### Placeholder scan

No TBDs, no "implement later" — every step has concrete code or a concrete command with expected output.

### Type / name consistency

- `ThreadRecord.tmux_window_name` — added Task 1, referenced in Tasks 3/4/5/6.
- `runIdleSweep` signature matches between Task 3 impl and Task 5 wiring (same `IdleSweepDeps` shape).
- `runIdleSweepOnce` — Task 5 adds it; Task 5 test + Task 6 test call it. Consistent.
- `killTmuxWindow` — signature `(session, windowName) => Promise<void>` in spec (§Code structure), Task 3 tests, and Task 5 daemon method. Consistent.
- `HIBERNATE_NOTICE` — only referenced in Task 3. Test asserts substring "休眠" which is present. Consistent.

### Ambiguity

The one interpretive call was "boundary: exactly 24 h" — I codified `>` (strict greater than) in the selector (`now - rec.last_message_at <= idleMs` → skip). The test asserts the equality case is skipped. Unambiguous.
