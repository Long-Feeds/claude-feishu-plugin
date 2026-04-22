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

test("terminal register auto-announces; first reply seeds thread on announce root; subsequent reply stays in thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const calls: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { calls.push({ op: "create", a }); return { data: { message_id: "om_announce" } } },
        reply: async (a) => { calls.push({ op: "reply", a }); return { data: { message_id: "m_reply", thread_id: "t1" } } },
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

  // Shim provides a stable session_id (Claude UUID). Daemon has no prior
  // state for "S1", so it auto-announces and primes pendingRoots.
  s.write(frame({ id: 1, op: "register", session_id: "S1", pid: 1, cwd: "/w" }))
  await wait(40)
  s.write(frame({ id: 2, op: "reply", text: "first", format: "text" }))
  await wait(30)
  s.write(frame({ id: 3, op: "reply", text: "second", format: "text" }))
  await wait(50)

  const createdCalls = calls.filter((c) => c.op === "create")
  const replyCalls = calls.filter((c) => c.op === "reply")
  // 1 create = the announce root. 2 replies = both land in the thread
  // (first seeds via reply_in_thread=true, second stays with =false).
  expect(createdCalls.length).toBe(1)
  expect(replyCalls.length).toBe(2)
  expect(replyCalls[0].a.data.reply_in_thread).toBe(true)
  expect(replyCalls[1].a.data.reply_in_thread).toBe(false)

  s.end()
  await daemon.stop()
})

test("top-level DM triggers feishu-spawn via injected spawn_cmd", async () => {
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

test("first delivered inbound auto-populates hubChatId when unset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]
  // hubChatId intentionally unset.
  saveAccess(join(dir, "access.json"), acc)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0, defaultCwd: "/tmp",
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_1", chat_id: "oc_autohub", chat_type: "p2p",
      message_type: "text", content: '{"text":"hi"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(30)

  const { loadAccess: la } = await import("../src/access")
  const after = la(join(dir, "access.json"))
  expect(after.hubChatId).toBe("oc_autohub")
  await daemon.stop()
})

test("terminal register (fresh session, hub configured) auto-announces and primes thread root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_announce" } } },
        reply: async () => ({ data: { message_id: "m2", thread_id: "t1" } }),
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

  // session_id=null → fresh terminal session (shim without FEISHU_SESSION_ID env)
  s.write(frame({ id: 1, op: "register", session_id: null, pid: 1, cwd: "/tmp/xb" }))
  await wait(50)

  expect(created.length).toBe(1)
  expect(created[0].data.receive_id).toBe("oc_hub")
  // The announce should mention cwd so the user can tell which session lit up.
  expect(created[0].data.content).toContain("/tmp/xb")

  // Claude's first reply should now seed a thread off the announce message
  // rather than creating a second root (pendingRoots primed by the announce).
  s.write(frame({ id: 2, op: "reply", text: "hello", format: "text" }))
  await wait(50)
  expect(created.length).toBe(1) // no second root create
  s.end()
  await daemon.stop()
})

test("terminal register pushes a bridge hint inbound so Claude knows to post updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: { message_id: "om_announce" } }),
        reply: async () => ({ data: {} }), patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    bridgeHintDelayMs: 0, // skip production's 5s MCP-handshake wait
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  const frames: any[] = []
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), (m) => frames.push(m)))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({ id: 1, op: "register", session_id: null, pid: 1, cwd: "/tmp/xb" }))
  await wait(120)

  // Expect a push:inbound with feishu-bridge-hint source and the hub chat_id.
  const hint = frames.find((f) => f?.push === "inbound" && f?.meta?.source === "feishu-bridge-hint")
  expect(hint).toBeDefined()
  expect(hint.meta.chat_id).toBe("oc_hub")
  expect(hint.meta.initial).toBe("true")
  expect(hint.content.length).toBeGreaterThan(20) // non-empty guidance text
  s.end()
  await daemon.stop()
})

test("terminal register (fresh session, cwd matches existing terminal thread) reuses session_id and skips announce", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_new_announce" } } },
        reply: async () => ({ data: {} }), patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Seed threads.json with a prior inactive terminal session for the cwd
  // we're about to register in — simulates a prior `claude` that we're now
  // resuming via `claude --resume`.
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_prior"] = {
    session_id: "S_PRIOR", chat_id: "oc_hub", root_message_id: "om_prior",
    cwd: "/proj/resume-me", origin: "terminal", status: "inactive",
    last_active_at: Date.now() - 30_000, last_message_at: Date.now() - 30_000,
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  const replies: any[] = []
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), (m) => replies.push(m)))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({ id: 1, op: "register", session_id: null, pid: 1, cwd: "/proj/resume-me" }))
  await wait(80)

  // Register response should carry the REUSED session_id, not a new ULID.
  const registerResp = replies.find((r) => r.id === 1)
  expect(registerResp?.session_id).toBe("S_PRIOR")
  // No fresh announce — we reused the existing thread.
  expect(created.length).toBe(0)

  s.end()
  await daemon.stop()
})

test("terminal register with session_id whose announce is in pendingRoots (persisted) does NOT re-announce", async () => {
  // Regression: `bun sync` cycles the daemon. If a terminal session had
  // announced but not yet seen its first reply, the old in-memory-only
  // pendingRoots was wiped → next shim reconnect looked "fresh" → duplicate
  // announce. Fixed by persisting pendingRoots in threads.json.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_new" } } },
        reply: async () => ({ data: {} }), patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Seed threads.json with a pending-root entry (no thread binding yet) —
  // simulates daemon restart after announce but before Claude's first reply.
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.pendingRoots = {
    "uuid-abc": { chat_id: "oc_hub", root_message_id: "om_previously_announced", created_at: Date.now() - 5000 },
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({ id: 1, op: "register", session_id: "uuid-abc", pid: 1, cwd: "/proj" }))
  await wait(50)

  // alreadyPending was true via persisted pendingRoots → no duplicate announce
  expect(created.length).toBe(0)
  s.end()
  await daemon.stop()
})

test("terminal register with known session_id (thread record exists) does NOT re-announce", async () => {
  // claude --resume: shim resolves Claude's UUID from /proc and sends it as
  // session_id. Daemon recognises the session from threads.json (prior Claude
  // already replied at least once, so the thread binding exists) → skips the
  // announce and routes into the existing thread.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_x" } } },
        reply: async () => ({ data: {} }), patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Seed threads.json with a binding for this session_id, simulating a
  // prior `claude` that had already replied (so we have a thread record).
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_existing"] = {
    session_id: "01RECON", chat_id: "oc_hub", root_message_id: "om_root",
    cwd: "/tmp", origin: "terminal", status: "inactive",
    last_active_at: Date.now() - 1000, last_message_at: Date.now() - 1000,
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))

  s.write(frame({ id: 1, op: "register", session_id: "01RECON", pid: 1, cwd: "/tmp" }))
  await wait(50)

  // alreadyBound is true via threads.json → announce skipped.
  expect(created.length).toBe(0)
  s.end()
  await daemon.stop()
})

test("hook_post routes by claude_session_uuid into that session's existing thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const replies: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (a) => { replies.push(a); return { data: { message_id: "m_hook" } } },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Seed: session UUID already has a bound thread (Claude has replied before).
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_live"] = {
    session_id: "uuid-live", chat_id: "oc_hub", root_message_id: "om_root",
    cwd: "/proj", origin: "terminal", status: "active",
    last_active_at: Date.now(), last_message_at: Date.now(),
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  const out: any[] = []
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), (m) => out.push(m)))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({
    id: 1, op: "hook_post",
    claude_session_uuid: "uuid-live",
    cwd: "/proj",
    text: "finished counting 5 lines",
  }))
  await wait(60)

  expect(replies.length).toBe(1)
  expect(replies[0].path.message_id).toBe("om_root")
  expect(replies[0].data.reply_in_thread).toBe(false)  // existing thread, no re-seed
  const ack = out.find((m) => m.id === 1)
  expect(ack?.ok).toBe(true)
  expect(ack?.thread_id).toBe("t_live")
  s.end()
  await daemon.stop()
})

test("hook_post with no thread but a pending announce root seeds the thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const replies: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (a) => { replies.push(a); return { data: { message_id: "m_seed", thread_id: "t_seeded" } } },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Seed a pendingRoot (announced but not yet replied)
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.pendingRoots = {
    "uuid-fresh": { chat_id: "oc_hub", root_message_id: "om_announce", created_at: Date.now() },
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({
    id: 1, op: "hook_post",
    claude_session_uuid: "uuid-fresh",
    cwd: "/proj/fresh",
    text: "first hook event",
  }))
  await wait(60)

  expect(replies.length).toBe(1)
  expect(replies[0].path.message_id).toBe("om_announce")
  expect(replies[0].data.reply_in_thread).toBe(true)  // seeds the thread

  // pendingRoots[uuid-fresh] was consumed → threads binding is created
  const after = (await import("../src/threads")).loadThreads(threadsFile)
  expect(after.pendingRoots?.["uuid-fresh"]).toBeUndefined()
  expect(Object.values(after.threads).some((r) => r.session_id === "uuid-fresh" && r.status === "active")).toBe(true)

  s.end()
  await daemon.stop()
})

test("delivered inbound message gets a 'received' emoji reaction on the trigger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const reactions: { message_id: string; emoji_type: string }[] = []
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: {
        create: async (a) => {
          reactions.push({
            message_id: a.path.message_id,
            emoji_type: a.data.reaction_type.emoji_type,
          })
          return {}
        },
      },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]; acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0,
    defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_trigger", chat_id: "oc_dm", chat_type: "p2p",
      message_type: "text", content: '{"text":"hi"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(50)

  const trigger = reactions.find((r) => r.message_id === "om_trigger")
  expect(trigger).toBeDefined()
  expect(trigger!.emoji_type).toBe("OnIt")
  await daemon.stop()
})

test("dropped message (disallowed sender) gets no reaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const reactions: { message_id: string; emoji_type: string }[] = []
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: {
        create: async (a) => {
          reactions.push({
            message_id: a.path.message_id,
            emoji_type: a.data.reaction_type.emoji_type,
          })
          return {}
        },
      },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = []; acc.dmPolicy = "disabled"
  saveAccess(join(dir, "access.json"), acc)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0,
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_stranger" }, sender_type: "user" },
    message: {
      message_id: "om_dropped", chat_id: "oc_dm", chat_type: "p2p",
      message_type: "text", content: '{"text":"hi"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(50)

  expect(reactions.length).toBe(0)
  await daemon.stop()
})

test("reply into closed thread gets a distinct 'closed' reaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const reactions: { message_id: string; emoji_type: string }[] = []
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: {
        create: async (a) => {
          reactions.push({
            message_id: a.path.message_id,
            emoji_type: a.data.reaction_type.emoji_type,
          })
          return {}
        },
      },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]; acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_closed"] = {
    session_id: "S_DEAD", chat_id: "oc_dm", root_message_id: "m0", cwd: "/tmp",
    origin: "feishu", status: "closed",
    last_active_at: 0, last_message_at: 0,
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0, defaultCwd: "/tmp",
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_into_closed", chat_id: "oc_dm", chat_type: "p2p",
      thread_id: "t_closed",
      message_type: "text", content: '{"text":"anyone there?"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(50)

  const onTrigger = reactions.filter((r) => r.message_id === "om_into_closed").map((r) => r.emoji_type)
  expect(onTrigger).toContain("CrossMark")
  await daemon.stop()
})

test("reply in inactive thread triggers resume spawn with FEISHU_RESUME_UUID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const spawned: { argv: string[]; env: Record<string, string> }[] = []
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

  // Seed threads.json with an inactive thread.
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t1"] = {
    session_id: "S_OLD", claude_session_uuid: "uuid-xyz",
    chat_id: "oc_dm", root_message_id: "m0", cwd: "/tmp",    // use /tmp so it exists
    origin: "feishu", status: "inactive",
    last_active_at: 0, last_message_at: 0,
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async (argv, env) => { spawned.push({ argv, env }); return 0 },
    defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_r1", chat_id: "oc_dm", chat_type: "p2p",
      thread_id: "t1",
      message_type: "text", content: '{"text":"continue"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(30)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.env.FEISHU_RESUME_UUID).toBe("uuid-xyz")
  expect(spawned[0]!.env.FEISHU_SESSION_ID).toBe("S_OLD")
  // resume regression guard: the reply text must be staged for injection into
  // the respawned pane. Without this, revival spawns Claude with no prompt
  // and the user's message disappears.
  const pending = (daemon as any).pendingFeishuInbound.get("S_OLD")
  expect(pending).toBeDefined()
  expect(pending.content).toBe("continue")
  expect(pending.meta.thread_id).toBe("t1")
  await daemon.stop()
})
