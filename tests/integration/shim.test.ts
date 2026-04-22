import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { spawn } from "child_process"
import { FakeDaemon } from "./fake-daemon"

test("shim registers with daemon on startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-"))
  const sock = join(dir, "daemon.sock")
  const fd = new FakeDaemon(sock); await fd.start()
  const shim = spawn("bun", ["src/shim.ts"], {
    env: { ...process.env, FEISHU_DAEMON_SOCKET: sock, FEISHU_SESSION_ID: "S1" },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const init = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }) + "\n"
  shim.stdin.write(init)
  await new Promise((r) => setTimeout(r, 500))
  expect(fd.received.some((m) => m.op === "register" && m.session_id === "S1")).toBe(true)
  shim.kill()
  await fd.stop()
})

test("shim reconnects and re-registers after daemon restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-test-"))
  const sock = join(dir, "daemon.sock")
  const fd1 = new FakeDaemon(sock); await fd1.start()
  const shim = spawn("bun", ["src/shim.ts"], {
    env: { ...process.env, FEISHU_DAEMON_SOCKET: sock, FEISHU_SESSION_ID: "S2" },
    stdio: ["pipe", "pipe", "inherit"],
  })
  shim.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }) + "\n")
  await new Promise((r) => setTimeout(r, 300))
  expect(fd1.received.some((m) => m.op === "register")).toBe(true)
  await fd1.stop()
  await new Promise((r) => setTimeout(r, 200))
  const fd2 = new FakeDaemon(sock); await fd2.start()
  await new Promise((r) => setTimeout(r, 3000))
  expect(fd2.received.some((m) => m.op === "register" && m.session_id === "S2")).toBe(true)
  shim.kill()
  await fd2.stop()
})

test("shim without FEISHU_SESSION_ID persists daemon-assigned id across reconnects", async () => {
  // Regression: terminal-origin sessions don't have FEISHU_SESSION_ID in env,
  // so they register with session_id=null. Daemon assigns a ULID on first
  // register. On daemon restart, shim must re-use that ULID — otherwise
  // daemon sees null again, treats the reconnect as a fresh terminal
  // registration, and fires a duplicate `🟢 session online` announce.
  const dir = mkdtempSync(join(tmpdir(), "shim-test-"))
  const sock = join(dir, "daemon.sock")
  const ASSIGNED = "01ASSIGNEDBYDAEMON"

  // Custom fake-daemon that echoes a fixed ULID when session_id is null,
  // so we can assert the shim reuses it on reconnect.
  const fd1 = new FakeDaemon(sock)
  fd1.onMsg = function (msg: any) {
    this.received.push(msg)
    if (msg.op === "register") {
      this.conn.write(
        JSON.stringify({
          id: msg.id, ok: true,
          session_id: msg.session_id ?? ASSIGNED,
          thread_id: null,
        }) + "\n",
      )
    }
  }
  await fd1.start()

  const env = { ...process.env, FEISHU_DAEMON_SOCKET: sock } as any
  delete env.FEISHU_SESSION_ID
  const shim = spawn("bun", ["src/shim.ts"], { env, stdio: ["pipe", "pipe", "inherit"] })
  shim.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }) + "\n")
  await new Promise((r) => setTimeout(r, 400))
  const firstRegister = fd1.received.find((m) => m.op === "register")
  expect(firstRegister?.session_id ?? null).toBeNull()

  await fd1.stop()
  await new Promise((r) => setTimeout(r, 200))

  const fd2 = new FakeDaemon(sock); await fd2.start()
  await new Promise((r) => setTimeout(r, 3000))
  const reRegister = fd2.received.find((m) => m.op === "register")
  expect(reRegister?.session_id).toBe(ASSIGNED)

  shim.kill()
  await fd2.stop()
})
