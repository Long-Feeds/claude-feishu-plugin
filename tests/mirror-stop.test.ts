import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { extractLastAssistantText, waitForFreshAssistantText } from "../hooks/mirror-stop"

function writeJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mirror-test-"))
  const path = join(dir, "transcript.jsonl")
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return path
}

test("extractLastAssistantText returns the most recent assistant text block", () => {
  const path = writeJsonl([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: "older reply" }] } },
    { message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "text", text: "newest reply" },
    ] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  ])
  expect(extractLastAssistantText(path)).toBe("newest reply")
})

test("extractLastAssistantText concatenates multiple text blocks within the same turn", () => {
  const path = writeJsonl([
    { message: { role: "assistant", content: [
      { type: "text", text: "first block" },
      { type: "tool_use", id: "t", name: "Read", input: {} },
      { type: "text", text: "second block" },
    ] } },
  ])
  expect(extractLastAssistantText(path)).toBe("first block\n\nsecond block")
})

test("extractLastAssistantText skips tool-only assistant turns and falls back to earlier text", () => {
  const path = writeJsonl([
    { message: { role: "assistant", content: [{ type: "text", text: "first reply" }] } },
    { message: { role: "assistant", content: [
      { type: "tool_use", id: "t", name: "Bash", input: {} },
    ] } },
  ])
  expect(extractLastAssistantText(path)).toBe("first reply")
})

test("extractLastAssistantText returns empty string if no assistant text anywhere", () => {
  const path = writeJsonl([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "ask" }] } },
  ])
  expect(extractLastAssistantText(path)).toBe("")
})

test("waitForFreshAssistantText waits for a new assistant-text event to appear (Stop-hook race)", async () => {
  // Simulate the race: baseline has 1 assistant text; during the wait a
  // second one is "flushed". Helper must return the newer one.
  let contents = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "older" }] } }) + "\n"
  const reader = (_p: string) => contents
  const resultPromise = waitForFreshAssistantText("/fake", 2000, reader)
  // Flush a new event after 200ms
  setTimeout(() => {
    contents += JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "fresh" }] } }) + "\n"
  }, 200)
  expect(await resultPromise).toBe("fresh")
})

test("waitForFreshAssistantText returns latest text when no growth within window (quiet exit)", async () => {
  const content = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "only" }] } }) + "\n"
  const reader = (_p: string) => content
  expect(await waitForFreshAssistantText("/fake", 300, reader)).toBe("only")
})
