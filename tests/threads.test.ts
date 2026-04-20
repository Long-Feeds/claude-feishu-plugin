import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  loadThreads, saveThreads, upsertThread, markInactive, markActive,
  close as closeThread, findBySessionId, findByThreadId,
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
    cwd: "/w", origin: "X-b", status: "active",
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
    cwd: "/w", origin: "X-b", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  const found = findBySessionId(store, "S1")
  expect(found?.thread_id).toBe("t1")
})

test("markInactive then markActive cycle", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "X-b", status: "active",
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
    cwd: "/w", origin: "X-b", status: "inactive",
    last_active_at: 1, last_message_at: 1,
  })
  closeThread(store, "t1")
  expect(store.threads["t1"]!.status).toBe("closed")
})

test("markActive does NOT reopen closed threads", () => {
  const store = loadThreads(file)
  upsertThread(store, "t1", {
    session_id: "S1", chat_id: "c1", root_message_id: "m1",
    cwd: "/w", origin: "X-b", status: "active",
    last_active_at: 1, last_message_at: 1,
  })
  closeThread(store, "t1")
  expect(store.threads["t1"]!.status).toBe("closed")
  markActive(store, "S1")
  expect(store.threads["t1"]!.status).toBe("closed")   // still closed
})
