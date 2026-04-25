// One-off manual integration check: sends a markdown-with-tables message to a
// real Feishu chat via the patched FeishuApi, so we can visually confirm
// tables render as aligned ASCII code blocks end-to-end.
//
// Usage:
//   source ~/.claude/channels/feishu/.env
//   bun run tests/integration/live-markdown-table.ts <chat_id> [reply_to_message_id]
//
// Does NOT touch the running daemon — opens its own lark Client.

import * as lark from "@larksuiteoapi/node-sdk"
import { FeishuApi } from "../../src/feishu-api"

async function main() {
  const chatId = process.argv[2]
  const replyTo = process.argv[3]
  if (!chatId) {
    process.stderr.write("usage: bun live-markdown-table.ts <chat_id> [reply_to_message_id]\n")
    process.exit(1)
  }
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    process.stderr.write("FEISHU_APP_ID / FEISHU_APP_SECRET missing; source ~/.claude/channels/feishu/.env\n")
    process.exit(1)
  }
  const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu })
  const api = new FeishuApi(client as any)

  const text = [
    "**集成验证：markdown 表格渲染**",
    "",
    "下面一张普通表 + 一张含 CJK/对齐标记的表：",
    "",
    "| Name  | Age | Role        |",
    "| ----- | --: | :---------: |",
    "| Alice |  30 | Engineer    |",
    "| Bob   |   2 | Intern      |",
    "",
    "| 姓名   | 年龄 | 角色 |",
    "| ------ | ---: | :--: |",
    "| 张三   |   28 | 前端 |",
    "| 李四四 |    5 | 实习 |",
    "",
    "常规 markdown 依然有效：",
    "- **bold** / *italic* / `inline code`",
    "- [link](https://example.com)",
    "",
    "```ts",
    "// 原代码块内部的 | A | B | 不会被改写",
    "const x: string = 'a|b|c'",
    "```",
  ].join("\n")

  if (replyTo) {
    const res = await api.sendInThread({
      root_message_id: replyTo, text, format: "markdown", seed_thread: false,
    })
    process.stdout.write(`sent reply message_id=${res.message_id} thread_id=${res.thread_id ?? ""}\n`)
  } else {
    const res = await api.sendRoot({ chat_id: chatId, text, format: "markdown" })
    process.stdout.write(`sent root message_id=${res.message_id} thread_id=${res.thread_id ?? ""}\n`)
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e?.stack ?? e}\n`)
  process.exit(1)
})
