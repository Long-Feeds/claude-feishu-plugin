# Feishu Channel for Claude Code

Bridges [Feishu (Lark)](https://www.feishu.cn/) messaging to a Claude Code session via the [Model Context Protocol](https://modelcontextprotocol.io/). Messages you send on Feishu reach Claude Code; replies and reactions come back.

No public IP or webhook required — uses Feishu's WebSocket long connection.

## Architecture

```
                    ┌──────────────────────┐
                    │   Feishu / Lark App  │
                    │   (mobile / desktop) │
                    └──────────┬───────────┘
                               │ user types message
                               ▼
                    ┌──────────────────────┐
                    │  Feishu Open Platform│
                    │  msg-frontier (WSS)  │
                    └──────────┬───────────┘
                               │ im.message.receive_v1
                               │ (long-lived WebSocket — no public IP)
                               ▼
   ┌─────────────────────────────────────────────────────────┐
   │  server.ts  (this plugin — single-file MCP server)      │
   │                                                         │
   │   ┌─────────────┐    ┌──────────────┐    ┌──────────┐   │
   │   │  WSClient   │───▶│ access gate  │───▶│  notify  │   │
   │   │  (lark SDK) │    │ (access.json │    │  (MCP    │   │
   │   └─────────────┘    │  pairing /   │    │  channel)│   │
   │                      │  allowlist / │    └────┬─────┘   │
   │                      │  groups)     │         │         │
   │                      └──────┬───────┘         │         │
   │                             │ drop / pair /   │         │
   │                             │ deliver         │         │
   │                             ▼                 │         │
   │                  ┌────────────────────┐       │         │
   │                  │  pairing reply     │       │         │
   │                  │  via reply tool    │       │         │
   │                  └────────────────────┘       │         │
   │                                               │         │
   │   tools exposed via MCP stdio  ◀──────────────┘         │
   │   ┌──────┐ ┌──────┐ ┌────────────┐ ┌─────────────────┐  │
   │   │reply │ │react │ │edit_message│ │download_attach. │  │
   │   └──┬───┘ └──┬───┘ └─────┬──────┘ └────────┬────────┘  │
   └──────┼────────┼───────────┼─────────────────┼───────────┘
          │        │           │                 │
          │ Feishu Open API (HTTPS, app-token)   │
          │   im.message.create / .reply         │
          │   im.messageReaction.create          │
          │   im.message.patch                   │
          │   im.messageResource.get             │
          │        │           │                 │
          ▼        ▼           ▼                 ▼
                    ┌──────────────────────┐
                    │  Feishu Open Platform│
                    └──────────┬───────────┘
                               │ delivered to chat
                               ▼
                    ┌──────────────────────┐
                    │   Feishu / Lark App  │
                    └──────────────────────┘

   stdio (JSON-RPC)  ▲                ▲ /feishu:configure
                     │                │ /feishu:access
                     ▼                │ (terminal-only mutations)
   ┌─────────────────────────────────────────────────────────┐
   │              Claude Code (host process)                 │
   │   spawns server.ts via .mcp.json → bun run start        │
   └─────────────────────────────────────────────────────────┘

   State on disk:  ~/.claude/channels/feishu/
                     ├── .env          (FEISHU_APP_ID / FEISHU_APP_SECRET)
                     ├── access.json   (dmPolicy, allowFrom, groups, pending)
                     ├── approved/     (pairing handoff to server)
                     └── inbox/        (downloaded attachments)
```

**Inbound path** — Feishu pushes events over a WebSocket long connection
(no webhook, no public IP). The access gate decides per message: drop,
issue a pairing code, or deliver to Claude Code as an MCP channel notification.

**Outbound path** — Claude Code calls one of four MCP tools (`reply`,
`react`, `edit_message`, `download_attachment`); the server translates them
into Feishu Open API HTTPS calls with the app's tenant access token. The
`reply` tool re-checks the target chat against the gate before sending,
so a compromised Claude session can't broadcast to arbitrary chats.

**Control plane** — `/feishu:configure` and `/feishu:access` are Claude Code
skills the user runs from the terminal. They only edit local files
(`.env`, `access.json`, `approved/`) — they never call Feishu directly,
and the server is the only thing that talks to Feishu's API.

## Quick Start

### 1. Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create an enterprise app.
2. Copy the **App ID** (`cli_xxx`) and **App Secret** from the Credentials page.
3. Under **Bot** capability, enable the bot.
4. Under **Event Subscription**:
   - Set dispatch method to **"Use long connection to receive events"** (使用长连接接收事件).
   - Subscribe to `im.message.receive_v1`.
5. Add permissions: `im:message`, `im:message:send_as_bot`, `im:resource`.
   Optionally add `im:message.reactions:write` for emoji reactions.
6. Publish the app version and have your admin approve it.

### 2. Install the Plugin

Two lines, no clone — Claude Code pulls the marketplace straight from GitHub
and installs the plugin:

```bash
claude plugin marketplace add Long-Feeds/claude-feishu-plugin
claude plugin install feishu@claude-feishu
```

Restart Claude Code so the new MCP server is picked up. The first run will
auto-install dependencies (`@larksuiteoapi/node-sdk`, MCP SDK) via the
`bun install` step in `.mcp.json` — give it a few seconds.

> **Requires** [Bun](https://bun.sh/) on `PATH` — `.mcp.json` launches the
> server with `bun run start`.

To uninstall later: `claude plugin uninstall feishu` and
`claude plugin marketplace remove claude-feishu`.

<details>
<summary>Local development install (clone the repo)</summary>

If you're hacking on the plugin itself, point the marketplace at a local
checkout instead:

```bash
git clone https://github.com/Long-Feeds/claude-feishu-plugin.git
cd claude-feishu-plugin
bun install
claude plugin marketplace add "$(pwd)"
claude plugin install feishu@claude-feishu
```

</details>

### 3. Configure Credentials

```
/feishu:configure cli_xxx your_app_secret_here
```

This saves credentials to `~/.claude/channels/feishu/.env` (chmod 600).

### 4. Pair Your Account

1. DM your bot on Feishu — it replies with a 6-character pairing code.
2. In Claude Code: `/feishu:access pair <code>`
3. The bot confirms pairing. You're connected!

### 5. Lock Down Access

Once everyone is paired:

```
/feishu:access policy allowlist
```

## Tools

The plugin exposes four MCP tools to Claude Code:

| Tool | Purpose |
|------|---------|
| `reply` | Send text/files to a Feishu chat |
| `react` | Add emoji reaction (THUMBSUP, SMILE, HEART, etc.) |
| `edit_message` | Update a previously sent message |
| `download_attachment` | Download image/file from a Feishu message |

## Access Control

See [ACCESS.md](ACCESS.md) for the full access control documentation.

**Summary:**

- **DM Policies**: `pairing` (default) → `allowlist` (recommended) → `disabled`
- **Group Support**: Opt-in per group, with optional @-mention requirement
- **Pairing Flow**: Unknown user DMs bot → gets code → user approves in terminal

Manage access with `/feishu:access`:

```
/feishu:access                     # Show status
/feishu:access pair <code>         # Approve a pairing
/feishu:access allow <open_id>     # Add to allowlist directly
/feishu:access remove <open_id>    # Remove from allowlist
/feishu:access policy allowlist    # Lock down to allowlist only
/feishu:access group add <chat_id> # Enable a group
```

## Configuration

| Env Variable | Description |
|---|---|
| `FEISHU_APP_ID` | Feishu app ID (cli_xxx) |
| `FEISHU_APP_SECRET` | Feishu app secret |
| `FEISHU_STATE_DIR` | Override state directory (default: `~/.claude/channels/feishu`) |
| `FEISHU_ACCESS_MODE` | Set to `static` for read-only access config |

## Requirements

- [Bun](https://bun.sh/) runtime — used by `.mcp.json` to launch `server.ts`
- Claude Code 2.1+ (with `claude plugin marketplace` support)
- A Feishu (Lark) self-built app with Bot capability

## Project Layout

```
.claude-plugin/
  plugin.json          # plugin metadata
  marketplace.json     # local marketplace manifest (registers ./ as the plugin)
.mcp.json              # tells Claude Code how to launch the MCP server
server.ts              # single-file MCP server (~1k LOC)
skills/
  configure/SKILL.md   # /feishu:configure
  access/SKILL.md      # /feishu:access
test-ws.ts             # standalone WebSocket smoke test (debugging only)
ACCESS.md              # full access control reference
```

## Troubleshooting

- **Bot doesn't reply to my DM** — check `~/.claude/channels/feishu/access.json`.
  If `dmPolicy` is `allowlist` and your `open_id` isn't in `allowFrom`, the
  message is dropped silently. Flip back to `pairing` temporarily, DM, then
  approve with `/feishu:access pair <code>`.
- **Events never arrive** — make sure the Feishu app's event subscription is
  set to **"Use long connection"** (not webhook), and that you don't have a
  stale `bun server.ts` running elsewhere. With the same `APP_ID`, Feishu only
  delivers each event to one connected client.
- **`bun: command not found`** — install Bun and ensure it's on `PATH` for the
  shell that launches Claude Code. `.mcp.json` shells out via `bun run start`.

## License

Apache-2.0
