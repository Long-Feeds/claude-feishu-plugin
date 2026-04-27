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

// Without this filter, a thread that was already swept once (status flipped
// to inactive by runIdleSweep, last_message_at left untouched) would re-qualify
// on every subsequent sweep tick and fire the hibernate notice repeatedly —
// the user-visible bug was multiple identical "🛌 已休眠" messages spaced
// FEISHU_IDLE_SWEEP_HOURS apart in the same thread.
test("selectIdleFeishuThreads SKIPS status=inactive (already swept once)", () => {
  const now = 1_800_000_000_000
  const s = store({
    t_already_swept: {
      session_id: "S6", chat_id: "c", root_message_id: "m", cwd: "/w",
      origin: "feishu", status: "inactive",
      last_active_at: now - 5 * day, last_message_at: now - 5 * day,
    },
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
  // t24 has the oldest last_message_at (2d+24000ms ago); it should be first.
  // t0 has the newest (2d+0ms ago); it's the last candidate excluded by cap.
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
      notifyCalls.push({
        root_message_id: args.root_message_id,
        text: args.text,
        seed_thread: args.seed_thread,
      })
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
  expect(f.notifyCalls.length).toBe(1)
  expect(f.notifyCalls[0]!.root_message_id).toBe("m_root")
  expect(f.notifyCalls[0]!.text).toContain("休眠")
  expect(f.notifyCalls[0]!.seed_thread).toBe(false)
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
