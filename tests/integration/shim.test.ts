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

test("shim with FEISHU_SESSION_ID (resume-spawn env) persists that id across reconnects", async () => {
  // Resume-spawn path: daemon already knows the UUID and passes it via env.
  // Shim uses it directly (no jsonl probe), and must re-use the same id on
  // reconnect so daemon's handleRegister hits alreadyBound and doesn't
  // re-announce.
  const dir = mkdtempSync(join(tmpdir(), "shim-test-"))
  const sock = join(dir, "daemon.sock")
  const PRESET = "66666666-6666-4666-8666-666666666666"

  const fd1 = new FakeDaemon(sock); await fd1.start()
  const env = {
    ...process.env,
    FEISHU_DAEMON_SOCKET: sock,
    FEISHU_SESSION_ID: PRESET,
    FEISHU_SHIM_SKIP_UUID_PROBE: "1",
  } as any
  const shim = spawn("bun", ["src/shim.ts"], { env, stdio: ["pipe", "pipe", "inherit"] })
  shim.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }) + "\n")
  await new Promise((r) => setTimeout(r, 400))
  const firstRegister = fd1.received.find((m) => m.op === "register")
  expect(firstRegister?.session_id).toBe(PRESET)

  await fd1.stop()
  await new Promise((r) => setTimeout(r, 200))

  const fd2 = new FakeDaemon(sock); await fd2.start()
  await new Promise((r) => setTimeout(r, 3000))
  const reRegister = fd2.received.find((m) => m.op === "register")
  expect(reRegister?.session_id).toBe(PRESET)

  shim.kill()
  await fd2.stop()
})
