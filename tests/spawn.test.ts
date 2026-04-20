import { test, expect } from "bun:test"
import { buildSpawnCommand } from "../src/spawn"

test("Y-b spawn uses tmux new-window with cwd and session env", () => {
  const { argv, env } = buildSpawnCommand({
    session_id: "S1",
    cwd: "/home/me/workspace/foo",
    initial_prompt: "hello",
    tmux_session: "claude-feishu",
    kind: "Y-b",
  })
  expect(argv[0]).toBe("tmux")
  expect(argv).toContain("new-window")
  expect(argv).toContain("-t")
  expect(argv).toContain("claude-feishu")
  expect(argv).toContain("-c")
  expect(argv).toContain("/home/me/workspace/foo")
  expect(env.FEISHU_SESSION_ID).toBe("S1")
  expect(env.FEISHU_INITIAL_PROMPT).toBe(Buffer.from("hello").toString("base64"))
})

test("resume spawn embeds FEISHU_RESUME_UUID", () => {
  const { env } = buildSpawnCommand({
    session_id: "S2",
    cwd: "/w",
    initial_prompt: "cont",
    tmux_session: "claude-feishu",
    kind: "resume",
    claude_session_uuid: "uuid-xyz",
  })
  expect(env.FEISHU_RESUME_UUID).toBe("uuid-xyz")
})
