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
