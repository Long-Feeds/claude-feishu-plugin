import { createServer, Server, Socket } from "net"
import { NdjsonParser, frame } from "../../src/ipc"

export class FakeDaemon {
  readonly received: any[] = []
  server!: Server
  conn!: Socket
  constructor(private socketPath: string) {}

  async start(): Promise<void> {
    this.server = createServer((conn) => {
      this.conn = conn
      const p = new NdjsonParser()
      conn.on("data", (buf: Buffer) => p.feed(buf.toString("utf8"), (m) => this.onMsg(m)))
    })
    await new Promise<void>((r) => this.server.listen(this.socketPath, () => r()))
  }

  onMsg(msg: any): void {
    this.received.push(msg)
    if (msg.op === "register") {
      this.conn.write(frame({ id: msg.id, ok: true, session_id: msg.session_id ?? "S_FAKE", thread_id: null }))
    }
  }

  send(push: any): void {
    this.conn.write(frame(push))
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
