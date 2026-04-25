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

test("register with null session_id is REJECTED (UUID-only contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock,
    feishuApi: null as any, wsStart: async () => {},
  })
  const resp = await connectAndSend(sock, {
    id: 1, op: "register", session_id: null, pid: process.pid, cwd: "/tmp",
  })
  expect(resp.ok).toBe(false)
  expect(resp.error).toContain("session_id required")
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
  // state for "S1"; register itself no longer announces — the UserPromptSubmit
  // hook triggers it using the first prompt as the title.
  s.write(frame({ id: 1, op: "register", session_id: "S1", pid: 1, cwd: "/w" }))
  await wait(40)
  s.write(frame({ id: 10, op: "user_prompt", claude_session_uuid: "S1", cwd: "/w", prompt: "my first task" }))
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

test("terminal user_prompt announces to hub using the prompt as title and primes thread root", async () => {
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

  // Fresh terminal session registering with a real UUID. Register alone no
  // longer announces; the UserPromptSubmit hook drives the announce with a
  // title.
  const uuid = "11111111-1111-4111-8111-111111111111"
  s.write(frame({ id: 1, op: "register", session_id: uuid, pid: 1, cwd: "/tmp/xb" }))
  await wait(40)
  expect(created.length).toBe(0)

  s.write(frame({ id: 2, op: "user_prompt", claude_session_uuid: uuid, cwd: "/tmp/xb", prompt: "fix the login bug" }))
  await wait(60)

  expect(created.length).toBe(1)
  expect(created[0].data.receive_id).toBe("oc_hub")
  expect(created[0].data.content).toContain("/tmp/xb")
  // Prompt text should be in the root message content as the title line.
  expect(created[0].data.content).toContain("fix the login bug")

  // Claude's first reply should now seed a thread off the announce message
  // rather than creating a second root (pendingRoots primed by the announce).
  s.write(frame({ id: 3, op: "reply", text: "hello", format: "text" }))
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
  s.write(frame({ id: 1, op: "register", session_id: "22222222-2222-4222-8222-222222222222", pid: 1, cwd: "/tmp/xb" }))
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

test("terminal register with same UUID as an existing (inactive) thread flips it active without re-announcing", async () => {
  // Resume path in the UUID-only model: `claude --resume <uuid>` → shim
  // probes jsonl → finds the SAME UUID as an existing thread in threads.json
  // → registers with that UUID → handleRegister hits alreadyBound and runs
  // markActive; no fresh announce.
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

  const priorUuid = "33333333-3333-4333-8333-333333333333"
  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_prior"] = {
    session_id: priorUuid, chat_id: "oc_hub", root_message_id: "om_prior",
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
  s.write(frame({ id: 1, op: "register", session_id: priorUuid, pid: 1, cwd: "/proj/resume-me" }))
  await wait(80)

  const registerResp = replies.find((r) => r.id === 1)
  expect(registerResp?.ok).toBe(true)
  expect(registerResp?.session_id).toBe(priorUuid)
  expect(created.length).toBe(0) // no fresh announce for a known UUID

  // And the thread should be flipped back to active.
  const { loadThreads: lt } = await import("../src/threads")
  const persisted = lt(threadsFile)
  expect(persisted.threads["t_prior"]?.status).toBe("active")

  s.end()
  await daemon.stop()
})

test("user_prompt arriving BEFORE register (claude --print race) is buffered and drained at register time", async () => {
  // In `claude --print` mode the UserPromptSubmit hook fires as soon as the
  // CLI arg is parsed — often before the shim has finished its 3s jsonl
  // UUID probe and registered with the daemon. Daemon must buffer the
  // prompt by cwd and use it when register later arrives, otherwise we
  // lose the title and the session ends up unannounced.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_raced" } } },
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
    bridgeHintDelayMs: 0,
  })

  // Hook connection arrives first — simulating the race — no live shim yet.
  const hook = connect(sock)
  await new Promise<void>((r) => hook.on("connect", () => r()))
  hook.write(frame({
    id: 1, op: "user_prompt", claude_session_uuid: "u-race",
    cwd: "/race/cwd", prompt: "the racing prompt",
  }))
  await wait(50)
  expect(created.length).toBe(0)  // buffered, not announced yet
  hook.end()

  // Now the shim registers. Daemon should drain the buffer and announce
  // with the buffered prompt as the title.
  const shim = connect(sock)
  await new Promise<void>((r) => shim.on("connect", () => r()))
  shim.write(frame({ id: 2, op: "register", session_id: "u-race", pid: 99, cwd: "/race/cwd" }))
  await wait(60)
  expect(created.length).toBe(1)
  expect(created[0].data.content).toContain("the racing prompt")

  shim.end()
  await daemon.stop()
})

test("multiple user_prompts before shim registers — first wins as announce title", async () => {
  // Manual-start scenario: the user runs `claude` from a terminal, types a
  // few prompts while claude is still loading MCP servers (the shim's UUID
  // probe defaults to 30s). Each UserPromptSubmit fires before the shim
  // registers. The original logic last-write-wins-overwrote the buffer, so
  // whatever prompt happened to land just before register became the title —
  // not the user's actual first request.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_first" } } },
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
    bridgeHintDelayMs: 0,
  })

  const hook = connect(sock)
  await new Promise<void>((r) => hook.on("connect", () => r()))
  hook.write(frame({
    id: 1, op: "user_prompt", claude_session_uuid: "u-slow",
    cwd: "/slow/cwd", prompt: "the actual first request",
  }))
  await wait(20)
  hook.write(frame({
    id: 2, op: "user_prompt", claude_session_uuid: "u-slow",
    cwd: "/slow/cwd", prompt: "follow-up while still loading",
  }))
  await wait(20)
  hook.write(frame({
    id: 3, op: "user_prompt", claude_session_uuid: "u-slow",
    cwd: "/slow/cwd", prompt: "yet another impatient retry",
  }))
  await wait(20)
  hook.end()

  const shim = connect(sock)
  await new Promise<void>((r) => shim.on("connect", () => r()))
  shim.write(frame({ id: 10, op: "register", session_id: "u-slow", pid: 99, cwd: "/slow/cwd" }))
  await wait(60)
  expect(created.length).toBe(1)
  expect(created[0].data.content).toContain("the actual first request")
  expect(created[0].data.content).not.toContain("follow-up")
  expect(created[0].data.content).not.toContain("impatient")

  shim.end()
  await daemon.stop()
})

test("user_prompt with channel-wrapped or bridge-hint text is suppressed and does NOT announce", async () => {
  // Regression: Claude Code fires UserPromptSubmit for MCP channel notifications
  // (inbound feishu messages, bridge-hint echoes). The hook filters these, but
  // daemon also re-checks defensively — if a stray variant (like
  // `<channel source="plugin:feishu:feishu" ...>`) leaks past the hook, it
  // must not become the thread title.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_leak" } } },
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
    bridgeHintDelayMs: 0,
  })
  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (b: Buffer) => parser.feed(b.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))
  const filteredUuid = "44444444-4444-4444-8444-444444444444"
  s.write(frame({ id: 1, op: "register", session_id: filteredUuid, pid: 1, cwd: "/filtered/cwd" }))
  await wait(40)

  // 1) channel-wrapped leak with the real-world source string.
  s.write(frame({
    id: 2, op: "user_prompt", claude_session_uuid: "", cwd: "/filtered/cwd",
    prompt: `<channel source="plugin:feishu:feishu" chat_id="oc_a" message_id="om_b">hi</channel>`,
  }))
  await wait(40)
  expect(created.length).toBe(0)

  // 2) bridge-hint echo.
  s.write(frame({
    id: 3, op: "user_prompt", claude_session_uuid: "", cwd: "/filtered/cwd",
    prompt: "⚡ FEISHU BRIDGE — this session is mirroring...",
  }))
  await wait(40)
  expect(created.length).toBe(0)

  // Real prompt still works.
  s.write(frame({
    id: 4, op: "user_prompt", claude_session_uuid: "", cwd: "/filtered/cwd",
    prompt: "real first prompt",
  }))
  await wait(60)
  expect(created.length).toBe(1)
  expect(created[0].data.content).toContain("real first prompt")

  s.end()
  await daemon.stop()
})

test("terminal register with ignored cwd prefix does NOT announce, even after first prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const created: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async (a) => { created.push(a); return { data: { message_id: "om_should_not_exist" } } },
        reply: async () => ({ data: {} }), patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const prev = process.env.FEISHU_IGNORE_CWD_PREFIXES
  process.env.FEISHU_IGNORE_CWD_PREFIXES = "/var/tmp/vibe-kanban/"
  try {
    const daemon = await Daemon.start({
      stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
      bridgeHintDelayMs: 0,
    })

    const s = connect(sock)
    const parser = new NdjsonParser()
    const replies: any[] = []
    s.on("data", (b: Buffer) => parser.feed(b.toString("utf8"), (m) => replies.push(m)))
    await new Promise<void>((r) => s.on("connect", () => r()))
    s.write(frame({ id: 1, op: "register", session_id: "55555555-5555-4555-8555-555555555555", pid: 1, cwd: "/var/tmp/vibe-kanban/worktrees/foo" }))
    await wait(40)
    s.write(frame({ id: 2, op: "user_prompt", claude_session_uuid: "", cwd: "/var/tmp/vibe-kanban/worktrees/foo", prompt: "work the task" }))
    await wait(60)

    expect(created.length).toBe(0)
    // No bridge-hint either — this session should be completely invisible.
    expect(replies.find((r) => r?.meta?.source === "feishu-bridge-hint")).toBeUndefined()

    s.end()
    await daemon.stop()
  } finally {
    if (prev === undefined) delete process.env.FEISHU_IGNORE_CWD_PREFIXES
    else process.env.FEISHU_IGNORE_CWD_PREFIXES = prev
  }
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

test("Stop hook mirror is skipped when reply was called the same turn", async () => {
  // Without this, every feishu-origin turn produces 2 messages: Claude's
  // explicit MCP `reply` call AND the Stop hook auto-mirroring Claude's
  // closing assistant text ("Reply sent"/"已回复"). Daemon now tracks
  // per-session reply count per turn and suppresses the mirror when reply
  // already fired.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const replyCalls: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (a) => { replyCalls.push(a); return { data: { message_id: "m_x", thread_id: "t_dup" } } },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_dup"] = {
    session_id: "uuid-dup", chat_id: "oc_hub", root_message_id: "om_root", cwd: "/proj",
    origin: "feishu", status: "active",
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

  // Register the session and call reply (simulates Claude's MCP reply).
  s.write(frame({ id: 1, op: "register", session_id: "uuid-dup", pid: 1, cwd: "/proj" }))
  await wait(40)
  s.write(frame({ id: 2, op: "reply", text: "**rendered markdown**", format: "markdown" }))
  await wait(40)
  expect(replyCalls.length).toBe(1)

  // Stop hook fires. Should be skipped, NOT produce another reply.
  s.write(frame({
    id: 3, op: "hook_post",
    claude_session_uuid: "uuid-dup", cwd: "/proj",
    text: "Reply sent.",
  }))
  await wait(40)
  expect(replyCalls.length).toBe(1)  // still 1 — Stop mirror suppressed
  const ack = out.find((m) => m.id === 3)
  expect(ack?.ok).toBe(true)
  expect(ack?.skipped).toBe("reply-fired")

  s.end()
  await daemon.stop()
})

test("Stop hook mirror still fires on a NEW turn (counter resets on UserPromptSubmit)", async () => {
  // Counter must reset between turns; otherwise after one reply the Stop
  // hook would be permanently silenced for the rest of the session.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const replyCalls: any[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (a) => { replyCalls.push(a); return { data: { message_id: "m_x", thread_id: "t_seq" } } },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_seq"] = {
    session_id: "uuid-seq", chat_id: "oc_hub", root_message_id: "om_root", cwd: "/proj",
    origin: "feishu", status: "active",
    last_active_at: Date.now(), last_message_at: Date.now(),
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))

  s.write(frame({ id: 1, op: "register", session_id: "uuid-seq", pid: 1, cwd: "/proj" }))
  await wait(40)
  // Turn 1: reply + Stop (suppressed).
  s.write(frame({ id: 2, op: "reply", text: "turn1", format: "markdown" }))
  await wait(40)
  s.write(frame({ id: 3, op: "hook_post", claude_session_uuid: "uuid-seq", cwd: "/proj", text: "Reply sent." }))
  await wait(40)
  expect(replyCalls.length).toBe(1)

  // Turn 2: new UserPromptSubmit resets counter; Stop hook now fires its mirror.
  s.write(frame({ id: 4, op: "user_prompt", claude_session_uuid: "uuid-seq", cwd: "/proj", prompt: "next question" }))
  await wait(40)
  s.write(frame({ id: 5, op: "hook_post", claude_session_uuid: "uuid-seq", cwd: "/proj", text: "mirror this" }))
  await wait(40)
  expect(replyCalls.length).toBe(2)  // mirror fired

  s.end()
  await daemon.stop()
})

test("feishu inbound to active session WITHOUT tmux_window_name reacts CrossMark instead of silent drop", async () => {
  // Regression: daemon used to recompute the tmux window name from
  // `fb:${session_id.slice(0,8)}`, which silently failed for fresh feishu-spawn
  // (where the actual window has a random name, not a session-id-derived one).
  // Send-keys to the non-existent window vanished without any user-visible
  // signal, leaving Claude idle and the operator confused. Fixed by sourcing
  // the window name from the SessionEntry (shim reports it from $TMUX_PANE
  // at register). When the entry has no window name, we now refuse to route
  // and surface a CrossMark on the inbound trigger so the failure is loud.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const reactions: { message_id: string; emoji_type: string }[] = []
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: {
        create: async (a) => {
          reactions.push({ message_id: a.path.message_id, emoji_type: a.data.reaction_type.emoji_type })
          return {}
        },
      },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]; acc.hubChatId = "oc_hub"
  acc.groups = { oc_chat: { requireMention: false, allowFrom: ["ou_abc"] } }
  saveAccess(join(dir, "access.json"), acc)

  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_orphan"] = {
    session_id: "ORPHAN_UUID", chat_id: "oc_chat", root_message_id: "om_root", cwd: "/tmp",
    origin: "feishu", status: "active",
    last_active_at: Date.now(), last_message_at: Date.now(),
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0, defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })

  // Register a shim that omits tmux_window_name (mimics a shim outside tmux,
  // or — historically — any shim before this fix).
  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({ id: 1, op: "register", session_id: "ORPHAN_UUID", pid: 1, cwd: "/tmp" }))
  await wait(40)

  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_unrouteable", chat_id: "oc_chat", chat_type: "group",
      thread_id: "t_orphan",
      message_type: "text", content: '{"text":"hello"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(50)

  const onTrigger = reactions.filter((r) => r.message_id === "om_unrouteable").map((r) => r.emoji_type)
  expect(onTrigger).toContain("CrossMark")
  s.end()
  await daemon.stop()
})

test("feishu inbound uses tmux_window_name reported by shim, not derived from session_id", async () => {
  // Positive companion to the CrossMark test above. Verifies the routing path
  // actually plumbs the shim-reported window name into the SessionEntry —
  // detected indirectly by the absence of a CrossMark (i.e. we did NOT bail
  // out for "no window name"). Cannot easily mock spawn at the tmux level,
  // but the SessionEntry assertion is the load-bearing piece.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const reactions: { message_id: string; emoji_type: string }[] = []
  const api = new FeishuApi({
    im: {
      message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }), patch: async () => ({}) },
      messageReaction: {
        create: async (a) => {
          reactions.push({ message_id: a.path.message_id, emoji_type: a.data.reaction_type.emoji_type })
          return {}
        },
      },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.allowFrom = ["ou_abc"]; acc.hubChatId = "oc_hub"
  acc.groups = { oc_chat: { requireMention: false, allowFrom: ["ou_abc"] } }
  saveAccess(join(dir, "access.json"), acc)

  const threadsFile = join(dir, "threads.json")
  const { loadThreads, saveThreads: st } = await import("../src/threads")
  const store = loadThreads(threadsFile)
  store.threads["t_routed"] = {
    session_id: "ROUTED_UUID", chat_id: "oc_chat", root_message_id: "om_root", cwd: "/tmp",
    origin: "feishu", status: "active",
    last_active_at: Date.now(), last_message_at: Date.now(),
  }
  st(threadsFile, store)

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async () => 0, defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })

  const s = connect(sock)
  const parser = new NdjsonParser()
  s.on("data", (buf: Buffer) => parser.feed(buf.toString("utf8"), () => {}))
  await new Promise<void>((r) => s.on("connect", () => r()))
  s.write(frame({
    id: 1, op: "register", session_id: "ROUTED_UUID", pid: 1, cwd: "/tmp",
    tmux_window_name: "fb:custom123",
  }))
  await wait(40)

  // SessionEntry should carry the reported name through unchanged.
  const entry = (daemon as any).state.get("ROUTED_UUID")
  expect(entry).toBeDefined()
  expect(entry.tmux_window_name).toBe("fb:custom123")

  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_routed", chat_id: "oc_chat", chat_type: "group",
      thread_id: "t_routed",
      message_type: "text", content: '{"text":"world"}', create_time: "0",
    },
  } as any, "ou_bot")
  await wait(50)

  // Routing path should NOT have refused — no CrossMark on this trigger.
  const onTrigger = reactions.filter((r) => r.message_id === "om_routed").map((r) => r.emoji_type)
  expect(onTrigger).not.toContain("CrossMark")
  s.end()
  await daemon.stop()
})

test("pendingFeishuSpawns is NOT hijacked by a stale shim registering in the same cwd with a different window_name", async () => {
  // Regression for the "Tesla topic posted as a new root message" bug.
  //
  // Setup that triggered it in the wild:
  //   * A prior claude in /workspace is still alive. Its shim is stuck in a
  //     reconnect loop (two shims collided on the same session_id earlier,
  //     and DaemonState.register's unconditional prev.conn.destroy() turned
  //     the collision into a 10ms-period re-register storm).
  //   * A fresh feishu message arrives → spawnFeishu parks an intent keyed by
  //     cwd so handleRegister can bind the NEW shim's UUID to the new thread.
  //   * Between the intent being parked and the new shim registering, one of
  //     the storm reconnects fires handleRegister. The old shim's cwd matches
  //     the intent's cwd, so it drains the intent and binds the NEW feishu
  //     thread to the OLD session. The real new shim arrives to a drained
  //     intent → gets treated as a terminal session → its first `reply`
  //     falls through to sendRoot → a new topic appears instead of a
  //     thread reply.
  //
  // Fix: handleRegister only consumes the intent if msg.tmux_window_name
  // matches the windowName spawnFeishu recorded. The old shim reports its
  // OWN window name (from the prior spawn), so it doesn't match and the
  // intent survives for the real new shim.
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
    defaultCwd: "/tmp/hijack-test", tmuxSession: "claude-feishu",
  })

  // Deliver a new-topic event → spawnFeishu parks pendingFeishuSpawns[cwd].
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_tesla", chat_id: "oc_chat", chat_type: "p2p",
      message_type: "text", content: '{"text":"analyze tesla"}', create_time: "0",
      thread_id: "omt_tesla",
    },
  } as any, "ou_bot")
  await wait(30)

  // Parse the fresh window name out of the spawnOverride argv. The intent
  // is keyed by cwd but gated by windowName — the stale shim's register
  // below uses a DIFFERENT window name on purpose.
  expect(spawned.length).toBe(1)
  const argv = spawned[0]!
  const nIdx = argv.indexOf("-n")
  const freshWindow = argv[nIdx + 1]!
  expect(freshWindow).toMatch(/^fb:/)

  // Stale shim from a prior spawn is still registered/reconnecting. It
  // shares the cwd but has its OWN window name. Under the old cwd-only
  // lookup, this register would drain the intent and bind the Tesla
  // thread to session=STALE_UUID.
  const stale = connect(sock)
  await new Promise<void>((r) => stale.on("connect", () => r()))
  stale.write(frame({
    id: 1, op: "register",
    session_id: "stale-uuid-0000-0000-0000-000000000000",
    pid: 99999, cwd: "/tmp/hijack-test",
    tmux_window_name: "fb:oldwindow-xyz",
  }))
  await wait(50)

  // Intent must STILL be there — not drained by the stale shim.
  const pending = (daemon as any).pendingFeishuSpawns as Map<string, any>
  expect(pending.has("/tmp/hijack-test")).toBe(true)

  // threads.json must NOT have bound Tesla → STALE_UUID.
  const { loadThreads: lt } = await import("../src/threads")
  const afterStale = lt(join(dir, "threads.json"))
  expect(afterStale.threads["omt_tesla"]).toBeUndefined()

  // Now the REAL fresh shim registers with the matching window name.
  const fresh = connect(sock)
  await new Promise<void>((r) => fresh.on("connect", () => r()))
  fresh.write(frame({
    id: 2, op: "register",
    session_id: "fresh-uuid-1111-1111-1111-111111111111",
    pid: 88888, cwd: "/tmp/hijack-test",
    tmux_window_name: freshWindow,
  }))
  await wait(50)

  // NOW the thread should be bound to the fresh session — threading is
  // preserved.
  const afterFresh = lt(join(dir, "threads.json"))
  expect(afterFresh.threads["omt_tesla"]).toBeDefined()
  expect(afterFresh.threads["omt_tesla"]!.session_id).toBe("fresh-uuid-1111-1111-1111-111111111111")
  expect(afterFresh.threads["omt_tesla"]!.tmux_window_name).toBe(freshWindow)

  stale.destroy(); fresh.destroy()
  await daemon.stop()
})

test("duplicate register with different live pid is rejected, preventing the destroy-reconnect storm", async () => {
  // Two shims (different processes, different pids, both conns alive) land
  // on the same session_id because of a UUID-probe race. The previous
  // DaemonState.register destroyed prev.conn on every duplicate — which for
  // two live shims meant an infinite destroy-reconnect loop that produced
  // tens of register events per second and — crucially — kept firing
  // handleRegister, which in turn hijacked pendingFeishuSpawns for any
  // fresh spawn in the same cwd. The fix refuses the second live-pid
  // register so the racing shim exits cleanly.
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: null as any, wsStart: async () => {},
  })

  const sid = "dup-uuid-0000-0000-0000-000000000000"

  // First shim — becomes the live registrant.
  const first = connect(sock)
  await new Promise<void>((r) => first.on("connect", () => r()))
  const firstReplies: any[] = []
  const firstParser = new NdjsonParser()
  first.on("data", (b: Buffer) => firstParser.feed(b.toString("utf8"), (m) => firstReplies.push(m)))
  first.write(frame({ id: 1, op: "register", session_id: sid, pid: 1001, cwd: "/x" }))
  await wait(40)
  expect(firstReplies[0]!.ok).toBe(true)

  // Second shim — different pid, attempts to register under the same sid.
  const second = connect(sock)
  await new Promise<void>((r) => second.on("connect", () => r()))
  const secondReplies: any[] = []
  const secondParser = new NdjsonParser()
  second.on("data", (b: Buffer) => secondParser.feed(b.toString("utf8"), (m) => secondReplies.push(m)))
  second.write(frame({ id: 2, op: "register", session_id: sid, pid: 1002, cwd: "/x" }))
  await wait(40)

  // Second should be rejected with an explicit error, not accepted.
  expect(secondReplies[0]!.ok).toBe(false)
  expect(String(secondReplies[0]!.error)).toContain("already claimed")

  // First must still be live — not torn down by the second register.
  expect(first.destroyed).toBe(false)

  // daemon.state should still hold the first shim's entry.
  const entry = (daemon as any).state.get(sid)
  expect(entry).toBeDefined()
  expect(entry.pid).toBe(1001)

  first.destroy(); second.destroy()
  await daemon.stop()
})

test("feishu-spawn register records tmux_window_name in the thread binding", async () => {
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
    defaultCwd: "/tmp/dwn-test", tmuxSession: "claude-feishu",
  })

  // Deliver an event with a thread_id so daemon uses the preExistingThreadId
  // branch (the only path that writes the thread directly at register time).
  await daemon.deliverFeishuEvent({
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_trigger", chat_id: "oc_test", chat_type: "p2p",
      message_type: "text", content: '{"text":"hi"}', create_time: "0",
      thread_id: "omt_preexisting",
    },
  } as any, "ou_bot")
  await wait(30)

  // handleRegister gates pendingFeishuSpawns consumption on tmux_window_name
  // matching the windowName spawnFeishu chose for the tmux new-window call.
  // Parse it out of the captured argv so the register below actually matches.
  expect(spawned.length).toBe(1)
  const argv = spawned[0]!
  const spawnWindow = argv[argv.indexOf("-n") + 1]!

  // Register a "shim" with the matching tmux_window_name.
  const s = connect(sock)
  await new Promise((r) => s.once("connect", () => r(null)))
  s.write(frame({
    op: "register", session_id: "fake-uuid-1234-5678-9abc-def012345678",
    pid: 1, cwd: "/tmp/dwn-test", tmux_window_name: spawnWindow,
  } as any))
  await wait(50)

  const { loadThreads: lt } = await import("../src/threads")
  const store = lt(join(dir, "threads.json"))
  expect(store.threads["omt_preexisting"]!.tmux_window_name).toBe(spawnWindow)

  s.destroy()
  await daemon.stop()
})

test("runIdleSweepOnce kills a stale feishu thread, leaves terminal thread alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"))
  const sock = join(dir, "daemon.sock")
  const spawnedCmds: string[][] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async () => ({ data: { message_id: "m_notif" } }),
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  // Pre-seed threads.json with a stale feishu thread and a stale terminal thread.
  // Terminal thread is seeded as inactive (Daemon.start() would flip active→inactive
  // at boot anyway; seeding it inactive here keeps the assertion straightforward).
  const { saveThreads: st } = await import("../src/threads")
  const now = Date.now()
  const TWO_DAYS = 2 * 86400_000
  st(join(dir, "threads.json"), {
    version: 1,
    threads: {
      t_feishu_stale: {
        session_id: "S_FEISHU", chat_id: "oc_test", root_message_id: "m_root_f",
        cwd: "/tmp", origin: "feishu", status: "active",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
        tmux_window_name: "fb:stale-abc",
      },
      t_terminal_stale: {
        session_id: "S_TERM", chat_id: "oc_hub", root_message_id: "m_root_t",
        cwd: "/tmp", origin: "terminal", status: "inactive",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
    },
    pendingRoots: {},
  })

  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    // Capture tmux commands for assertion instead of running real tmux.
    spawnOverride: async (argv) => { spawnedCmds.push(argv); return 0 },
    defaultCwd: "/tmp", tmuxSession: "claude-feishu",
  })

  const result = await daemon.runIdleSweepOnce(now)
  expect(result.killed).toEqual(["t_feishu_stale"])

  // Assert tmux kill-window captured
  const killCmd = spawnedCmds.find((a) => a[0] === "tmux" && a[1] === "kill-window")
  expect(killCmd).toBeDefined()
  expect(killCmd!.join(" ")).toContain("claude-feishu:fb:stale-abc")

  // Disk: feishu row → inactive; terminal row → untouched (stays inactive)
  const { loadThreads: lt } = await import("../src/threads")
  const back = lt(join(dir, "threads.json"))
  expect(back.threads["t_feishu_stale"]!.status).toBe("inactive")
  expect(back.threads["t_terminal_stale"]!.status).toBe("inactive")

  await daemon.stop()
})
