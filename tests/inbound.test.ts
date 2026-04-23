import { test, expect } from "bun:test"
import { extractTextAndAttachment } from "../src/inbound"

function postEvent(content: object): any {
  return {
    message: {
      message_id: "om_x",
      chat_id: "oc_x",
      message_type: "post",
      content: JSON.stringify(content),
    },
  }
}

test("post text + a tags extracted (baseline, was already working)", () => {
  const e = postEvent({
    zh_cn: { title: "", content: [
      [{ tag: "text", text: "see " }, { tag: "a", href: "https://example.com", text: "this link" }],
    ]},
  })
  expect(extractTextAndAttachment(e).text).toBe("see this link")
})

test("post code_block tag preserved as fenced code so Claude can read it", () => {
  // Regression: feishu's slash-menu / paste-code creates code_block tags. The
  // old parser filtered to tag==="text"|"a", so code blocks were SILENTLY
  // dropped — Claude saw an empty / "(rich text)" message instead of the user's
  // actual code. Without this fix, a user pasting code into the bot DM never
  // got their question answered because the daemon delivered no content.
  const e = postEvent({
    zh_cn: { title: "", content: [
      [{ tag: "text", text: "fix this bug:" }],
      [{ tag: "code_block", language: "go", text: "func main() {\n  panic(\"oops\")\n}" }],
    ]},
  })
  const out = extractTextAndAttachment(e).text
  expect(out).toContain("fix this bug:")
  expect(out).toContain("func main()")
  expect(out).toContain("panic(\"oops\")")
  // Fence with language so Claude treats it as code, not prose.
  expect(out).toContain("```go")
  expect(out).toContain("```")
})

test("post code_block without language still extracts text and fences", () => {
  const e = postEvent({
    zh_cn: { title: "", content: [
      [{ tag: "code_block", text: "echo hi" }],
    ]},
  })
  const out = extractTextAndAttachment(e).text
  expect(out).toContain("echo hi")
  expect(out).toContain("```")
})

test("post inline tags beyond text/a (md, lark_md, code) include their text", () => {
  // Defensive: feishu has a bunch of inline tags carrying user text. A strict
  // tag allow-list silently drops content. Switch to "drop a known-noise list
  // (at, img), keep text from anything else."
  const e = postEvent({
    zh_cn: { title: "", content: [
      [{ tag: "md", text: "**bold** body" }],
      [{ tag: "lark_md", text: "italic body" }],
      [{ tag: "text", text: "with " }, { tag: "code", text: "inline_code" }, { tag: "text", text: " inside" }],
    ]},
  })
  const out = extractTextAndAttachment(e).text
  expect(out).toContain("**bold** body")
  expect(out).toContain("italic body")
  expect(out).toContain("inline_code")
})

test("post @mention placeholder dropped (Claude doesn't need @_user_N text)", () => {
  const e = postEvent({
    zh_cn: { title: "", content: [
      [{ tag: "at", user_id: "ou_xxx", user_name: "claudeMan" }, { tag: "text", text: " hello" }],
    ]},
  })
  expect(extractTextAndAttachment(e).text.trim()).toBe("hello")
})

test("post with title preserves title and combines lines", () => {
  const e = postEvent({
    zh_cn: { title: "Bug report", content: [
      [{ tag: "text", text: "summary line" }],
    ]},
  })
  const out = extractTextAndAttachment(e).text
  expect(out).toContain("Bug report")
  expect(out).toContain("summary line")
})

test("post with no extractable content falls back to (rich text)", () => {
  const e = postEvent({ zh_cn: { title: "", content: [[{ tag: "img", image_key: "img_xxx" }]] } })
  expect(extractTextAndAttachment(e).text).toBe("(rich text)")
})
