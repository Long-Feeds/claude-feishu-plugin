# Feishu Claude Code Plugin

## 项目概述

飞书(Lark) Claude Code 插件，架构对标官方 Telegram 插件（MCP Server 模式）。通过飞书消息控制 Claude Code 会话。

## 架构

- 单文件 MCP Server (`server.ts`)，通过 stdio 与 Claude Code 通信
- 使用 `@larksuiteoapi/node-sdk` 的 WSClient (WebSocket 长连接) 接收飞书事件，无需公网 IP
- 访问控制：pairing（配对码）→ allowlist（白名单）→ disabled
- 状态文件存储在 `~/.claude/channels/feishu/`

## 文件结构

```
.claude-plugin/plugin.json    # 插件元数据
.mcp.json                     # MCP Server 启动配置 (bun runtime)
package.json                  # 依赖: @modelcontextprotocol/sdk, @larksuiteoapi/node-sdk
server.ts                     # 单文件 MCP Server (~1000行)
skills/configure/SKILL.md     # /feishu:configure 技能（配置凭证）
skills/access/SKILL.md        # /feishu:access 技能（管理访问控制）
test-ws.ts                    # 独立 WebSocket 测试脚本（调试用）
README.md                     # 用户文档
ACCESS.md                     # 访问控制详细文档
LICENSE                       # Apache-2.0
```

## 关键技术选型

| 维度 | 选型 |
|------|------|
| 运行时 | Bun |
| 飞书 SDK | @larksuiteoapi/node-sdk ^1.56.0 |
| MCP SDK | @modelcontextprotocol/sdk ^1.0.0 |
| 事件接收 | WSClient WebSocket 长连接 |
| 用户标识 | open_id (ou_xxx) |
| 凭证 | FEISHU_APP_ID + FEISHU_APP_SECRET (双凭证) |

## MCP 工具

| 工具 | 飞书 API | 说明 |
|------|----------|------|
| reply | im.message.create / .reply | 发送文本/文件，支持 text/post 格式 |
| react | im.messageReaction.create | 添加表情反应（THUMBSUP 等） |
| edit_message | im.message.patch | 编辑已发送消息 |
| download_attachment | im.messageResource.get | 下载图片/文件附件 |

## 与 Telegram 插件的关键差异

- 双凭证 (APP_ID + APP_SECRET) vs 单 token
- WebSocket 长连接 vs HTTP 长轮询
- open_id vs 数字 user_id
- 文件发送需先上传获取 key 再发消息
- emoji_type 名称 (THUMBSUP) vs Unicode emoji
- 权限按钮用纯文本回复 (y/n code) 替代 InlineKeyboard
- 聊天类型: p2p/group vs private/group/supergroup

## 状态目录

`~/.claude/channels/feishu/` — 凭证 (`.env`)、访问控制 (`access.json`)、
配对码、附件 inbox、approved 队列都在这里。**永远不要 commit 这个目录或其
内容**（`.gitignore` 已经覆盖）。

## 已知开发陷阱

- **事件被另一个进程吃掉**：同一 APP_ID 多个 WSClient 并发连接时，飞书只会
  把单条事件派发给其中一个客户端。开发期切换 `bun server.ts` / Claude Code
  插件 / `bun test-ws.ts` 时，先杀掉残留进程。
- **stdout 污染**：MCP 走 stdio JSON-RPC，server.ts 顶部把 `console.*` 全部
  重定向到 stderr。新增日志一律走 `process.stderr.write` 或 `console.error`。
- **double-reply on pair**：pairing 模式下 `replies` 计数限制为 2，避免被恶
  意刷码。改 gate 时小心别破坏这个上限。

## 开发/调试命令

```bash
# 安装依赖
bun install

# 独立测试 WebSocket 事件接收
bun test-ws.ts

# 作为 MCP Server 启动（需要 stdin 保持打开）
# 正常使用时由 Claude Code 通过 .mcp.json 自动启动
bun server.ts

# 查看当前访问控制状态
cat ~/.claude/channels/feishu/access.json
```

## 飞书应用配置要求

1. 飞书开放平台创建自建应用 (open.feishu.cn)
2. 启用 Bot 能力
3. 事件订阅设置为「使用长连接接收事件」
4. 订阅 `im.message.receive_v1` 事件
5. 添加权限: `im:message`, `im:message:send_as_bot`, `im:resource`
6. 发布版本并由管理员审批
