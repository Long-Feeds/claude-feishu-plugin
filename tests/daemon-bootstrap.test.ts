import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Daemon } from "../src/daemon"
import { FeishuApi } from "../src/feishu-api"
import { saveAccess, defaultAccess } from "../src/access"

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function quietApi(): FeishuApi {
  return new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async () => ({ data: {} }),
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}), delete: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) },
      file: { create: async () => ({}) },
    },
  } as any)
}

function makeFeishuEvent(text: string) {
  return {
    sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
    message: {
      message_id: "om_top",
      chat_id: "oc_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: "0",
    },
  } as any
}

test("spawnFeishu prepends bootstrap header when SOUL.md exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-bootstrap-test-"))
  try {
    const ws = join(dir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "SOUL.md"), "you are a lobster")

    const sock = join(dir, "daemon.sock")
    const capturedEnvs: Array<Record<string, string>> = []
    const acc = defaultAccess()
    acc.allowFrom = ["ou_abc"]
    acc.hubChatId = "oc_hub"
    saveAccess(join(dir, "access.json"), acc)

    const daemon = await Daemon.start({
      stateDir: dir,
      socketPath: sock,
      feishuApi: quietApi(),
      wsStart: async () => {},
      spawnOverride: async (_argv, env) => {
        capturedEnvs.push(env)
        return 0
      },
      defaultCwd: dir,
      tmuxSession: "claude-feishu",
    })

    const userText = "hi claude"
    await daemon.deliverFeishuEvent(makeFeishuEvent(userText), "ou_bot")
    await wait(40)

    expect(capturedEnvs.length).toBe(1)
    const encoded = capturedEnvs[0]!.FEISHU_INITIAL_PROMPT
    expect(encoded).toBeTruthy()
    const decoded = Buffer.from(encoded!, "base64").toString("utf8")
    expect(decoded.startsWith("# Feishu Channel Bootstrap")).toBe(true)
    expect(decoded).toContain("## SOUL\nyou are a lobster")
    expect(decoded).toContain("# User Message")
    const userIdx = decoded.indexOf("# User Message")
    expect(userIdx).toBeGreaterThan(-1)
    expect(decoded.slice(userIdx)).toContain(userText)

    await daemon.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("spawnFeishu emits user prompt verbatim when no bootstrap files exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-bootstrap-test-"))
  try {
    const sock = join(dir, "daemon.sock")
    const capturedEnvs: Array<Record<string, string>> = []
    const acc = defaultAccess()
    acc.allowFrom = ["ou_abc"]
    acc.hubChatId = "oc_hub"
    saveAccess(join(dir, "access.json"), acc)

    const daemon = await Daemon.start({
      stateDir: dir,
      socketPath: sock,
      feishuApi: quietApi(),
      wsStart: async () => {},
      spawnOverride: async (_argv, env) => {
        capturedEnvs.push(env)
        return 0
      },
      defaultCwd: dir,
      tmuxSession: "claude-feishu",
    })

    const userText = "hi claude"
    await daemon.deliverFeishuEvent(makeFeishuEvent(userText), "ou_bot")
    await wait(40)

    expect(capturedEnvs.length).toBe(1)
    const encoded = capturedEnvs[0]!.FEISHU_INITIAL_PROMPT
    expect(encoded).toBeTruthy()
    const decoded = Buffer.from(encoded!, "base64").toString("utf8")
    expect(decoded).toBe(userText)

    await daemon.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("L2 resume path does not inject bootstrap header", async () => {
  // Even with a populated workspace dir, an inbound that takes the resume
  // code path (existing inactive thread → claude --resume <uuid>) must NOT
  // pick up the bootstrap. The resumed jsonl already has the conversation
  // state; injecting bootstrap here would duplicate the header.
  const dir = mkdtempSync(join(tmpdir(), "daemon-bootstrap-test-"))
  try {
    const ws = join(dir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "SOUL.md"), "DO NOT LEAK")

    const sock = join(dir, "daemon.sock")
    const capturedEnvs: Array<Record<string, string>> = []
    const acc = defaultAccess()
    acc.allowFrom = ["ou_abc"]
    acc.hubChatId = "oc_hub"
    saveAccess(join(dir, "access.json"), acc)

    // Seed threads.json with an inactive thread so the inbound takes the
    // L2 resume code path (mirrors tests/daemon-routing.test.ts:1113).
    const threadsFile = join(dir, "threads.json")
    const { loadThreads, saveThreads: st } = await import("../src/threads")
    const store = loadThreads(threadsFile)
    store.threads["t1"] = {
      session_id: "S_OLD",
      claude_session_uuid: "uuid-xyz",
      chat_id: "oc_dm",
      root_message_id: "m0",
      cwd: "/tmp",
      origin: "feishu",
      status: "inactive",
      last_active_at: 0,
      last_message_at: 0,
    }
    st(threadsFile, store)

    const daemon = await Daemon.start({
      stateDir: dir,
      socketPath: sock,
      feishuApi: quietApi(),
      wsStart: async () => {},
      spawnOverride: async (_argv, env) => {
        capturedEnvs.push(env)
        return 0
      },
      defaultCwd: "/tmp",
      tmuxSession: "claude-feishu",
    })

    const userText = "continue"
    await daemon.deliverFeishuEvent({
      sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" },
      message: {
        message_id: "om_r1",
        chat_id: "oc_dm",
        chat_type: "p2p",
        thread_id: "t1",
        message_type: "text",
        content: JSON.stringify({ text: userText }),
        create_time: "0",
      },
    } as any, "ou_bot")
    await wait(40)

    expect(capturedEnvs.length).toBe(1)
    // Confirm we actually hit the resume path (not the fresh-feishu spawn).
    expect(capturedEnvs[0]!.FEISHU_RESUME_UUID).toBe("uuid-xyz")
    const encoded = capturedEnvs[0]!.FEISHU_INITIAL_PROMPT
    expect(encoded).toBeTruthy()
    const decoded = Buffer.from(encoded!, "base64").toString("utf8")
    expect(decoded).not.toContain("# Feishu Channel Bootstrap")
    expect(decoded).not.toContain("DO NOT LEAK")

    await daemon.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
