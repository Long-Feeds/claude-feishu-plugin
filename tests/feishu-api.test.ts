import { test, expect } from "bun:test"
import { FeishuApi, type LarkLike } from "../src/feishu-api"

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

test("reactTo calls messageReaction.create", async () => {
  const { client, calls } = mockClient()
  const api = new FeishuApi(client)
  await api.reactTo("m1", "THUMBSUP")
  expect(calls[0]!.op).toBe("react")
  expect(calls[0]!.args.data.reaction_type.emoji_type).toBe("THUMBSUP")
})
