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
