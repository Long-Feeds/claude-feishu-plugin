// Thin wrapper around lark Client, encoding thread-aware send semantics.

import { createReadStream, statSync } from "fs"
import { basename, extname } from "path"

export type LarkLike = {
  im: {
    message: {
      create: (args: any) => Promise<any>
      reply: (args: any) => Promise<any>
      patch: (args: any) => Promise<any>
    }
    messageReaction: { create: (args: any) => Promise<any> }
    messageResource: { get: (args: any) => Promise<any> }
    image: { create: (args: any) => Promise<any> }
    file: { create: (args: any) => Promise<any> }
  }
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"])

export type TextFormat = "text" | "post" | "markdown"

export type SendResult = {
  message_id: string
  thread_id?: string
}

function buildContent(text: string, format: TextFormat): { content: string; msg_type: string } {
  if (format === "markdown") {
    // Feishu's post format with a single `md` element renders markdown (bold,
    // italic, blockquotes, code fences, links). Unlike an `interactive` card,
    // post-with-md still supports `reply_in_thread`, which we need for thread
    // routing. Verified with the live API — interactive cards return
    // "The request you send is not a valid operation" when replied into a
    // thread, but post-with-md threads fine.
    return {
      content: JSON.stringify({
        zh_cn: { title: "", content: [[{ tag: "md", text }]] },
      }),
      msg_type: "post",
    }
  }
  if (format === "post") {
    const lines = text.split("\n")
    return {
      content: JSON.stringify({
        zh_cn: { title: "", content: lines.map((line) => [{ tag: "text", text: line }]) },
      }),
      msg_type: "post",
    }
  }
  return { content: JSON.stringify({ text }), msg_type: "text" }
}

export class FeishuApi {
  constructor(private readonly client: LarkLike) {}

  async sendRoot(args: {
    chat_id: string
    text: string
    format: TextFormat
  }): Promise<SendResult> {
    const { content, msg_type } = buildContent(args.text, args.format)
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: args.chat_id, content, msg_type },
    })
    return {
      message_id: resp?.data?.message_id ?? "",
      thread_id: resp?.data?.thread_id || undefined,
    }
  }

  async sendInThread(args: {
    root_message_id: string
    text: string
    format: TextFormat
    seed_thread: boolean
  }): Promise<SendResult> {
    const { content, msg_type } = buildContent(args.text, args.format)
    const resp = await this.client.im.message.reply({
      path: { message_id: args.root_message_id },
      data: { content, msg_type, reply_in_thread: args.seed_thread },
    })
    return {
      message_id: resp?.data?.message_id ?? "",
      thread_id: resp?.data?.thread_id || undefined,
    }
  }

  async edit(args: { message_id: string; text: string; format: TextFormat }): Promise<void> {
    const { content } = buildContent(args.text, args.format)
    await this.client.im.message.patch({
      path: { message_id: args.message_id },
      data: { content },
    })
  }

  async reactTo(message_id: string, emoji_type: string): Promise<void> {
    await this.client.im.messageReaction.create({
      path: { message_id },
      data: { reaction_type: { emoji_type } },
    })
  }

  async downloadResource(args: {
    message_id: string
    file_key: string
    type: "image" | "file"
    dest_path: string
  }): Promise<void> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: args.message_id, file_key: args.file_key },
      params: { type: args.type },
    })
    await resp.writeFile(args.dest_path)
  }

  async sendFile(args: {
    chat_id: string
    path: string
  }): Promise<SendResult> {
    const ext = extname(args.path).toLowerCase()
    const name = basename(args.path)
    statSync(args.path)
    if (IMAGE_EXTS.has(ext)) {
      const up = await this.client.im.image.create({
        data: { image_type: "message", image: createReadStream(args.path) },
      })
      const image_key = up?.data?.image_key ?? up?.image_key
      if (!image_key) throw new Error("image upload returned no image_key")
      const resp = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: args.chat_id,
          msg_type: "image",
          content: JSON.stringify({ image_key }),
        },
      })
      return { message_id: resp?.data?.message_id ?? "" }
    }
    const up = await this.client.im.file.create({
      data: { file_type: "stream", file_name: name, file: createReadStream(args.path) },
    })
    const file_key = up?.data?.file_key ?? up?.file_key
    if (!file_key) throw new Error("file upload returned no file_key")
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: args.chat_id,
        msg_type: "file",
        content: JSON.stringify({ file_key }),
      },
    })
    return { message_id: resp?.data?.message_id ?? "" }
  }
}
