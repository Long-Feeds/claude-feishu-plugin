import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { connect, Socket } from "net"
import { Daemon } from "../src/daemon"

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
