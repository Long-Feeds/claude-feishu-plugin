import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  loadThreads, saveThreads, upsertThread, markInactive, markActive,
  close as closeThread, findBySessionId, findByThreadId, pruneInactive,
} from "../src/threads"

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "threads-test-")), "threads.json")
})

test("empty load returns empty map", () => {
  expect(loadThreads(file)).toEqual({ version: 1, threads: {} })
})

test("upsertThread persists and findByThreadId works", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "terminal", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  saveThreads(file, store)
  const back = loadThreads(file)
  expect(findByThreadId(back, "t1")?.session_id).toBe("S1")
})

test("findBySessionId reverse lookup", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "terminal", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  const found = findBySessionId(store, "S1")
  expect(found?.thread_id).toBe("t1")
})

test("markInactive then markActive cycle", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "terminal", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  markInactive(store, "S1")
  expect(store.threads["t1"]!.status).toBe("inactive")
  markActive(store, "S1")
  expect(store.threads["t1"]!.status).toBe("active")
})

test("close transitions to closed", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "terminal", status: "inactive",
    last_active_at: 1, last_message_at: 1,
  })
  closeThread(store, "t1")
  expect(store.threads["t1"]!.status).toBe("closed")
})

test("pruneInactive drops old inactive but keeps active, closed, and resumable", () => {
  const store = loadThreads(file)
  const now = Date.now()
  const old = now - 60 * 86400_000   // 60 days ago
  upsertThread(store, "t_old_inactive", {
    session_id: "S1", chat_id: "c", root_message_id: "m", cwd: "/", origin: "terminal",
    status: "inactive", last_active_at: old, last_message_at: old,
  })
  upsertThread(store, "t_old_closed", {
    session_id: "S2", chat_id: "c", root_message_id: "m", cwd: "/", origin: "terminal",
    status: "closed", last_active_at: old, last_message_at: old,
  })
  upsertThread(store, "t_active", {
    session_id: "S3", chat_id: "c", root_message_id: "m", cwd: "/", origin: "terminal",
    status: "active", last_active_at: old, last_message_at: old,
  })
  upsertThread(store, "t_recent_inactive", {
    session_id: "S4", chat_id: "c", root_message_id: "m", cwd: "/", origin: "terminal",
    status: "inactive", last_active_at: now - 1000, last_message_at: now - 1000,
  })
  // Resumable inactive — resume would be able to `claude --resume` this, so keep.
  upsertThread(store, "t_old_resumable", {
    session_id: "S5", claude_session_uuid: "uuid-keep",
    chat_id: "c", root_message_id: "m", cwd: "/", origin: "terminal",
    status: "inactive", last_active_at: old, last_message_at: old,
  })

  const pruned = pruneInactive(store, 30 * 86400_000)
  expect(pruned).toEqual(["t_old_inactive"])
  expect(Object.keys(store.threads).sort()).toEqual([
    "t_active", "t_old_closed", "t_old_resumable", "t_recent_inactive",
  ])
})

test("markActive does NOT reopen closed threads", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "terminal", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  closeThread(store, "t1")
  expect(store.threads["t1"]!.status).toBe("closed")
  markActive(store, "S1")
  expect(store.threads["t1"]!.status).toBe("closed")   // still closed
})
