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
