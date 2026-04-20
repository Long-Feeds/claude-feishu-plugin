import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { connect, Socket } from "net"
import { Daemon } from "../src/daemon"
import { frame, NdjsonParser } from "../src/ipc"

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function connectAndSend(socketPath: string, req: object): Promise<any> {
  const s = connect(socketPath)
  await new Promise<void>((r) => s.on("connect", () => r()))
  const parser = new NdjsonParser()
  const replies: any[] = []
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), (m) => replies.push(m)))
  s.write(frame(req))
  for (let i = 0; i < 50; i++) {
    if (replies.length > 0) break
    await wait(20)
  }
  s.end()
  return replies[0]
}

test("daemon binds socket and accepts a connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const daemon = await Daemon.start({
    stateDir: dir,
    socketPath: sock,
    feishuApi: null as any,
    wsStart: async () => {},
  })
  const s = connect(sock)
  await wait(50)
  expect(s.writable).toBe(true)
  s.end()
  await daemon.stop()
})

test("register with null session_id allocates a new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock,
    feishuApi: null as any, wsStart: async () => {},
  })
  const resp = await connectAndSend(sock, {
    id: 1, op: "register", session_id: null, pid: process.pid, cwd: "/tmp",
  })
  expect(resp.ok).toBe(true)
  expect(typeof resp.session_id).toBe("string")
  expect(resp.session_id.length).toBeGreaterThan(0)
  await daemon.stop()
})

test("register with existing session_id echoes it back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock,
    feishuApi: null as any, wsStart: async () => {},
  })
  const resp = await connectAndSend(sock, {
    id: 1, op: "register", session_id: "01HXYABC", pid: process.pid, cwd: "/tmp",
  })
  expect(resp.session_id).toBe("01HXYABC")
  await daemon.stop()
})

import { FeishuApi } from "../src/feishu-api"
import { saveAccess, defaultAccess } from "../src/access"

test("X-b first reply creates root msg; subsequent reply creates thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const calls: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { calls.push({ op: "create", a }); return { data: { message_id: "m1" } } },
        reply: async (a) => { calls.push({ op: "reply", a }); return { data: { message_id: "m2", thread_id: "t1" } } },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"; acc.allowFrom = ["ou_abc"]
  saveAccess(join(dir, "access.json"), acc)
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  const replies: any[] = []
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), (m) => replies.push(m)))
  await new Promise<void>((r) => s.on("connect", () => r()))

  s.write(frame({ id: 1, op: "register", session_id: "S1", pid: 1, cwd: "/w" }))
  await wait(30)
  s.write(frame({ id: 2, op: "reply", text: "first", format: "text" }))
  await wait(30)
  s.write(frame({ id: 3, op: "reply", text: "second", format: "text" }))
  await wait(50)

  const createdCalls = calls.filter((c) => c.op === "create")
  const replyCalls = calls.filter((c) => c.op === "reply")
  expect(createdCalls.length).toBe(1)
  expect(replyCalls.length).toBe(1)
  expect(replyCalls[0].a.data.reply_in_thread).toBe(true)

  s.end()
  await daemon.stop()
})

test("top-level DM triggers Y-b spawn via injected spawn_cmd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const spawned: string[][] = []
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
    spawnOverride: async (argv) => { spawned.push(argv); return 0 },
    defaultCwd: "/home/me/workspace",
    tmuxSession: "claude-feishu",
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_top", chat_id: "oc_dm", chat_type: "p2p",
      message_type: "text", content: '{"text":"hi claude"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(30)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.join(" ")).toContain("new-window")
  expect(spawned[0]!.join(" ")).toContain("/home/me/workspace")
  await daemon.stop()
})
