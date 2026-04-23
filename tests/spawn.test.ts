import { test, expect } from "bun:test"
import { buildSpawnCommand, tmuxNameSlug } from "../src/spawn"

test("feishu-spawn uses tmux new-window with cwd and session env", () => {
  const { argv, env } = buildSpawnCommand({
    session_id: "S1",
    cwd: "/home/me/workspace/foo",
    initial_prompt: "hello",
    tmux_session: "claude-feishu",
    kind: "feishu",
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

test("tmuxNameSlug keeps first N CJK chars", () => {
  expect(tmuxNameSlug("做一个当前的图片生成调研报告", 5)).toBe("做一个当前")
})

test("tmuxNameSlug collapses whitespace and strips shell-quoting hazards", () => {
  expect(tmuxNameSlug("hello   world", 7)).toBe("hello_w")
  expect(tmuxNameSlug('quote "and" colon: backslash\\', 12)).toBe("quote_and_co")
})

test("tmuxNameSlug strips control chars and leading underscores from collapsed lead whitespace", () => {
  expect(tmuxNameSlug("\n\t  task name", 8)).toBe("task_nam")
  expect(tmuxNameSlug("normal", 6)).toBe("normal")
})

test("tmuxNameSlug returns empty when input is all-symbol after sanitisation", () => {
  expect(tmuxNameSlug("   \n\t", 5)).toBe("")
  expect(tmuxNameSlug("", 5)).toBe("")
})
