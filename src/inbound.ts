// Ported from server.ts:761-871 without semantic changes.

export type AttachmentMeta = {
  kind: string
  file_key: string
  size?: number
  mime?: string
  name?: string
}

export function extractCardText(node: any, out: string[] = []): string[] {
  if (node == null) return out
  if (typeof node === "string") {
    const s = node.trim()
    if (s) out.push(s)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) extractCardText(item, out)
    return out
  }
  if (typeof node === "object") {
    for (const key of ["content", "text", "title", "subtitle", "plain_text", "lark_md"]) {
      const v = (node as any)[key]
      if (typeof v === "string") {
        const s = v.trim()
        if (s) out.push(s)
      } else if (v && typeof v === "object") {
        extractCardText(v, out)
      }
    }
    for (const key of ["header", "body", "elements", "columns", "rows", "fields", "actions", "i18n_elements", "zh_cn", "en_us"]) {
      if ((node as any)[key] !== undefined) extractCardText((node as any)[key], out)
    }
  }
  return out
}

// Pull text out of one inline post node. Earlier code allow-listed tag in
// {text, a} only, which silently dropped every other rich-text tag — the
// most common casualty being `code_block`, so a user pasting code into the
// bot DM landed in Claude's lap as "(rich text)" with the actual code lost.
// This is now an opt-OUT list (drop @mentions and bare image refs since
// Claude can't act on them as inline text), with `code_block` re-fenced as
// a markdown code block so Claude sees the language.
function extractInlineText(node: any): string {
  if (!node || typeof node !== "object") return ""
  const tag = node.tag
  if (tag === "at") return ""   // @mention placeholder, no useful text
  if (tag === "img") return ""  // image ref, no inline text payload
  if (tag === "code_block") {
    const lang = typeof node.language === "string" ? node.language : ""
    const body = typeof node.text === "string" ? node.text : ""
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`
  }
  // Default: take whatever text/href the tag carries. Covers text, a, md,
  // lark_md, code, emotion, hr, quote, etc.
  return node.text ?? node.href ?? ""
}

export function extractTextAndAttachment(event: any): {
  text: string; attachment?: AttachmentMeta; imagePath?: string;
} {
  const msgType = event.message.message_type
  let text = ""
  let attachment: AttachmentMeta | undefined
  let imagePath: string | undefined

  try {
    const content = JSON.parse(event.message.content)
    switch (msgType) {
      case "text":
        text = content.text ?? ""
        text = text.replace(/@_user_\d+/g, "").trim()
        break
      case "post": {
        const parts: string[] = []
        const postContent = content.zh_cn ?? content.en_us ?? content
        if (postContent?.title) parts.push(postContent.title)
        for (const para of postContent?.content ?? []) {
          const line = (para as any[])
            .map((n: any) => extractInlineText(n))
            .filter(Boolean)
            .join("")
          if (line) parts.push(line)
        }
        text = parts.join("\n") || "(rich text)"
        break
      }
      case "image":
        text = "(image)"
        attachment = { kind: "image", file_key: content.image_key }
        break
      case "file":
        text = `(file: ${content.file_name ?? "file"})`
        attachment = { kind: "file", file_key: content.file_key, name: content.file_name }
        break
      case "audio":
        text = "(audio)"
        attachment = { kind: "audio", file_key: content.file_key }
        break
      case "media":
        text = "(video)"
        attachment = { kind: "media", file_key: content.file_key, name: content.file_name }
        break
      case "sticker":
        text = "(sticker)"
        attachment = { kind: "sticker", file_key: content.file_key }
        break
      case "interactive": {
        const lines = extractCardText(content)
        text = lines.length ? `(card)\n${lines.join("\n")}` : "(card)"
        break
      }
      default:
        text = `(${msgType})`
    }
  } catch {
    text = "(unparseable message)"
  }
  return { text, attachment, imagePath }
}
