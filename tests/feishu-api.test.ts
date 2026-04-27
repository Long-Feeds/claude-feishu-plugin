import { test, expect } from "bun:test"
import { FeishuApi, preprocessMarkdownForFeishu, type LarkLike } from "../src/feishu-api"

function mockClient(): { client: LarkLike; calls: any[] } {
  const calls: any[] = []
  const client: LarkLike = {
    im: {
      message: {
        create: async (args) => {
          calls.push({ op: "create", args })
          return { data: { message_id: "om_new", thread_id: "" } }
        },
        reply: async (args) => {
          calls.push({ op: "reply", args })
          return { data: { message_id: "om_reply", thread_id: "omt_thread" } }
        },
        patch: async (args) => {
          calls.push({ op: "patch", args })
          return {}
        },
      },
      messageReaction: {
        create: async (args) => {
          calls.push({ op: "react", args })
          return { data: { reaction_id: "rxn_mock" } }
        },
        delete: async (args) => {
          calls.push({ op: "unreact", args })
          return {}
        },
      },
      messageResource: {
        get: async (args) => {
          calls.push({ op: "download", args })
          return { writeFile: async (_p: string) => {} }
        },
      },
      image: { create: async () => ({ data: { image_key: "img_k" } }) },
      file: { create: async () => ({ data: { file_key: "file_k" } }) },
    },
  }
  return { client, calls }
}

test("sendRoot uses im.message.create when no reply_to", async () => {
  const { client, calls } = mockClient()
  const api = new FeishuApi(client)
  const res = await api.sendRoot({ chat_id: "c1", text: "hi", format: "text" })
  expect(res.message_id).toBe("om_new")
  expect(calls[0]!.op).toBe("create")
  expect(calls[0]!.args.data.receive_id).toBe("c1")
})

test("sendInThread uses im.message.reply with reply_in_thread=true on root", async () => {
  const { client, calls } = mockClient()
  const api = new FeishuApi(client)
  const res = await api.sendInThread({
    root_message_id: "m0", text: "go", format: "text",
    seed_thread: true,
  })
  expect(res.thread_id).toBe("omt_thread")
  expect(calls[0]!.op).toBe("reply")
  expect(calls[0]!.args.data.reply_in_thread).toBe(true)
})

test("reactTo calls messageReaction.create and returns reaction_id", async () => {
  const { client, calls } = mockClient()
  const api = new FeishuApi(client)
  const id = await api.reactTo("m1", "THUMBSUP")
  expect(calls[0]!.op).toBe("react")
  expect(calls[0]!.args.data.reaction_type.emoji_type).toBe("THUMBSUP")
  expect(id).toBe("rxn_mock")
})

test("removeReaction calls messageReaction.delete with message_id and reaction_id", async () => {
  const { client, calls } = mockClient()
  const api = new FeishuApi(client)
  await api.removeReaction("m1", "rxn_abc")
  expect(calls[0]!.op).toBe("unreact")
  expect(calls[0]!.args.path.message_id).toBe("m1")
  expect(calls[0]!.args.path.reaction_id).toBe("rxn_abc")
})

test("preprocessMarkdownForFeishu leaves text without tables unchanged", () => {
  const input = "# Heading\n\n**bold** and a [link](https://x.com)\n\n- one\n- two"
  expect(preprocessMarkdownForFeishu(input)).toBe(input)
})

test("preprocessMarkdownForFeishu rewrites a GFM table into an aligned code block", () => {
  const input = [
    "before",
    "",
    "| Name | Age |",
    "| --- | ---: |",
    "| Alice | 30 |",
    "| Bob | 2 |",
    "",
    "after",
  ].join("\n")
  const out = preprocessMarkdownForFeishu(input)
  // Table turned into a fenced block with aligned columns; right-aligned Age.
  expect(out).toContain("```")
  expect(out).toContain("| Name  | Age |")
  expect(out).toContain("| Alice |  30 |")
  expect(out).toContain("| Bob   |   2 |")
  // Surrounding text preserved.
  expect(out.startsWith("before\n\n```")).toBe(true)
  expect(out.endsWith("```\n\nafter")).toBe(true)
})

test("preprocessMarkdownForFeishu respects center alignment marker", () => {
  const input = "| A | B |\n| :-: | :-: |\n| xx | yyyy |"
  const out = preprocessMarkdownForFeishu(input)
  // Column A width 2, B width 4; centered.
  expect(out).toContain("| A  |  B   |")
  expect(out).toContain("| xx | yyyy |")
})

test("preprocessMarkdownForFeishu leaves tables inside code fences alone", () => {
  const input = [
    "```markdown",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "```",
  ].join("\n")
  expect(preprocessMarkdownForFeishu(input)).toBe(input)
})

test("preprocessMarkdownForFeishu ignores pipe lines that aren't tables", () => {
  const input = 'echo "a|b|c"\nanother line'
  expect(preprocessMarkdownForFeishu(input)).toBe(input)
})

test("preprocessMarkdownForFeishu handles CJK widths when aligning", () => {
  const input = "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n| 李四四 | 2 |"
  const out = preprocessMarkdownForFeishu(input)
  // Widest name column is 李四四 (6 cells); header 姓名 is 4 cells — padded.
  expect(out).toContain("| 姓名   | 年龄 |")
  expect(out).toContain("| 张三   | 30   |")
  expect(out).toContain("| 李四四 | 2    |")
})
