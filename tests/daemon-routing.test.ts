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
