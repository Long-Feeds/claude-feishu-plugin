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

type Alignment = "left" | "center" | "right"

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // East Asian Wide / Fullwidth ranges — counted as two cells so ASCII tables
  // stay aligned when cells contain CJK.
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

function padCell(s: string, width: number, align: Alignment): string {
  const pad = Math.max(0, width - visualWidth(s))
  if (align === "right") return " ".repeat(pad) + s
  if (align === "center") {
    const left = Math.floor(pad / 2)
    return " ".repeat(left) + s + " ".repeat(pad - left)
  }
  return s + " ".repeat(pad)
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return null
  let s = trimmed
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1]!
      i++
      continue
    }
    if (c === "|") {
      cells.push(cur.trim())
      cur = ""
    } else {
      cur += c
    }
  }
  cells.push(cur.trim())
  return cells.length > 0 ? cells : null
}

function parseAlignments(cells: string[]): Alignment[] | null {
  const result: Alignment[] = []
  for (const c of cells) {
    if (!/^:?-{1,}:?$/.test(c)) return null
    const left = c.startsWith(":")
    const right = c.endsWith(":")
    result.push(left && right ? "center" : right ? "right" : "left")
  }
  return result
}

function renderAsciiTable(
  headers: string[],
  aligns: Alignment[],
  rows: string[][],
): string {
  const widths = headers.map((h, i) => {
    let w = visualWidth(h)
    for (const r of rows) w = Math.max(w, visualWidth(r[i] ?? ""))
    return w
  })
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+"
  const renderRow = (cells: string[]) =>
    "| " + widths.map((w, i) => padCell(cells[i] ?? "", w, aligns[i] ?? "left")).join(" | ") + " |"
  const out: string[] = ["```", sep, renderRow(headers), sep]
  for (const r of rows) out.push(renderRow(r))
  out.push(sep, "```")
  return out.join("\n")
}

// Feishu's `md` tag in post messages supports a subset of markdown (bold,
// italic, strikethrough, lists, headings, code, code fences, blockquotes,
// links) but NOT GFM tables — pipes render as literal text. We rewrite each
// table into an aligned ASCII table inside a fenced code block so columns
// stay visually aligned under Feishu's monospace rendering. Everything
// outside tables passes through untouched.
export function preprocessMarkdownForFeishu(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let inFence = false
  let fenceMarker = ""
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker.startsWith(fenceMarker) || fenceMarker.startsWith(marker)) {
        inFence = false
        fenceMarker = ""
      }
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }
    const header = splitTableRow(line)
    if (header && header.length >= 1 && i + 1 < lines.length) {
      const sep = splitTableRow(lines[i + 1]!)
      if (sep && sep.length === header.length) {
        const aligns = parseAlignments(sep)
        if (aligns) {
          const rows: string[][] = []
          let j = i + 2
          while (j < lines.length) {
            const r = splitTableRow(lines[j]!)
            if (!r) break
            while (r.length < header.length) r.push("")
            if (r.length > header.length) r.length = header.length
            rows.push(r)
            j++
          }
          out.push(renderAsciiTable(header, aligns, rows))
          i = j
          continue
        }
      }
    }
    out.push(line)
    i++
  }
  return out.join("\n")
}

function buildContent(text: string, format: TextFormat): { content: string; msg_type: string } {
  if (format === "markdown") {
    // Feishu's post format with a single `md` element renders markdown (bold,
    // italic, blockquotes, code fences, links). Unlike an `interactive` card,
    // post-with-md still supports `reply_in_thread`, which we need for thread
    // routing. Verified with the live API — interactive cards return
    // "The request you send is not a valid operation" when replied into a
    // thread, but post-with-md threads fine.
    const rendered = preprocessMarkdownForFeishu(text)
    return {
      content: JSON.stringify({
        zh_cn: { title: "", content: [[{ tag: "md", text: rendered }]] },
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
