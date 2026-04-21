# Feishu Channel for Claude Code

Bridges [Feishu (Lark)](https://www.feishu.cn/) messaging to a Claude Code session via the [Model Context Protocol](https://modelcontextprotocol.io/). Messages you send on Feishu reach Claude Code; replies and reactions come back.

No public IP or webhook required — uses Feishu's WebSocket long connection.

## Prerequisites

- [Bun](https://bun.sh/) on `PATH` (runtime for both daemon and shim)
- `tmux` on `PATH` (daemon spawns new Claude sessions as tmux windows)
- systemd `--user` (Linux). macOS via launchd is future work.

## Architecture

```
                        ┌────────────────────────────┐
                        │   Feishu Open Platform     │
                        │   (WebSocket frontier)     │
                        └──────────┬─────────────────┘
                                   │ im.message.receive_v1 (WSS)
                                   ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  claude-feishu-daemon    (systemd --user service)           │
    │                                                             │
    │   WSClient  ─▶  gate (access.json)  ─▶  router              │
    │                                          │                  │
    │                                          ├─▶ thread_id 已知 │
    │                                          │    → forward to  │
    │                                          │       shim#N     │
    │                                          └─▶ 顶层新消息      │
    │                                               → spawn Y-b   │
    │                                                              │
    │   state:  access.json · threads.json · pending · inbox      │
    │   listen: unix://~/.claude/channels/feishu/daemon.sock      │
    └──────┬────────────────────────────────┬─────────────────────┘
           │ JSON-line IPC                  │ tmux new-window -t claude-feishu
           │                                ▼
     ┌─────┴──────┐                ┌───────────────────────┐
     │ shim #1    │ shim #2 ...    │  tmux session:        │
     │ (MCP over  │                │  "claude-feishu"      │
     │  stdio in  │                │  ┌─────┬─────┬─────┐  │
     │  each      │                │  │ win │ win │ win │  │
     │  Claude)   │                │  │  1  │  2  │  3  │  │
     └─────┬──────┘                │  │Y-b  │Y-b  │X-b  │  │
           │ stdio MCP             │  └─────┴─────┴─────┘  │
           ▼                       │ (each win runs its own │
     ┌───────────┐                 │  `claude` process with │
     │ Claude    │                 │  shim attached)        │
     │ Code      │                 │                        │
     │ session   │                 │                        │
     └───────────┘                 └───────────────────────┘
                             user attaches: `tmux attach -t claude-feishu`

   State on disk:  ~/.claude/channels/feishu/
                     ├── .env          (FEISHU_APP_ID / FEISHU_APP_SECRET)
                     ├── access.json   (dmPolicy, allowFrom, groups, pending, hubChatId)
                     ├── threads.json  (thread_id → session binding)
                     ├── daemon.sock   (Unix socket, 0600)
                     ├── daemon.pid
                     ├── approved/     (pairing handoff to daemon)
                     └── inbox/        (downloaded attachments)
```

The daemon runs under systemd and is the sole holder of the Feishu WebSocket.
Each `claude` session loads a thin MCP shim via `.mcp.json`; shims speak NDJSON
over the daemon's Unix socket and translate MCP tool calls ↔ Feishu actions on
behalf of their session.

**Control plane** — `/feishu:configure` and `/feishu:access` are Claude Code
skills the user runs from the terminal. They only edit local files
(`.env`, `access.json`, `approved/`) — they never call Feishu directly,
and the daemon is the only thing that talks to Feishu's API.

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

The first run will auto-install dependencies (`@larksuiteoapi/node-sdk`,
MCP SDK) via the `bun install` step in `.mcp.json` — give it a few seconds.

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

### 5. Install the systemd daemon

```
/feishu:configure install-service
```

This writes `~/.config/systemd/user/claude-feishu.service`, enables it, and
starts the daemon. Verify with:

```bash
systemctl --user status claude-feishu
```

Live logs: `journalctl --user -u claude-feishu -f`.

### 6. Launch Claude Code normally

Once the daemon is running, any `claude` session picks up the Feishu channel
automatically via the installed plugin's `.mcp.json`. No special flag needed.

Each top-level Feishu message to your bot will spawn a new Claude session as
a window in the `claude-feishu` tmux session. Replies in a thread route to
that session's shim; replies in an old (inactive) thread trigger `claude
--resume` in the same cwd.

### 7. Lock Down Access

Once everyone is paired:

```
/feishu:access policy allowlist
```

## Usage

Once the daemon is running (Step 5) and you're paired (Step 4), three flows
are available. Each Feishu thread corresponds to one Claude Code session.

### Flow 1 — DM the bot to spawn a new session (Y-b)

You're on mobile, want Claude to poke at something in `~/workspace`:

1. DM your bot: `帮我看看 ~/workspace/foo 里 flaky test 的栈怎么回事`
2. The daemon spawns a new Claude session as a tmux window (session
   `claude-feishu`). Initial cwd is `~/workspace` (override with env
   `FEISHU_DEFAULT_CWD` on the daemon).
3. Claude reads your message, starts working, and replies — that reply
   creates a **thread** rooted on your DM message. All subsequent progress
   updates land in the same thread.
4. Reply in the thread to give Claude more context.
5. Peek at the live session any time: `tmux attach -t claude-feishu` (each
   Y-b spawn is its own window).

### Flow 2 — Local terminal session pushes updates to Feishu (X-b)

You're working in a terminal with `claude`, want Feishu pings on a long-running task:

1. Open a terminal: `cd ~/workspace/somerepo && claude`.
2. The plugin's shim auto-attaches to the daemon (no flag needed after
   Step 5).
3. When Claude calls the `reply` tool — e.g., you asked "飞书通知我一下
   测试跑完", Claude decides to reply once it's done — the message goes to
   your **hub chat** (the DM you first paired with).
4. The first `reply` creates a root message; the second `reply` seeds a
   thread on top of that root. All further replies from this session stay
   in that thread.
5. You can answer in the thread to steer Claude remotely.

### Flow 3 — Revive a dead session by replying in an old thread (L2)

Terminal closed, laptop slept, or you ran `tmux kill-window` — the session
is gone but the thread in Feishu still exists (status=inactive).

1. Reply anything in that thread.
2. Daemon sees the inbound on an inactive thread → spawns a fresh `claude`
   in the original cwd and delivers your reply as its new prompt.
3. Thread goes back to `active`.

> ⚠️ **L2 today is conversation revival, not state resume.** Claude Code
> 2.1 doesn't expose its session UUID to MCP children, so the daemon can't
> call `claude --resume <uuid>`. The revived session gets a clean Claude
> context and your reply as the new task. It's the same cwd so files and
> git state carry over, but Claude's prior reasoning does not. If Claude
> Code later exposes the session UUID via env, the shim is already wired
> to report it (see `src/shim.ts`) and L2 flips automatically to real
> state resume.

### Managing sessions and threads

| Command | Effect |
|---|---|
| `/feishu:access threads` | List all threads grouped by status (active / inactive / closed) |
| `/feishu:access thread close <thread_id>` | Archive a thread — replies to it get "thread closed" auto-response |
| `/feishu:access thread kill <thread_id>` | `tmux kill-window` on the session's window; daemon auto-flips status to inactive |
| `/feishu:configure set-hub <chat_id>` | Change the hub chat for X-b sessions (first pair auto-sets this) |
| `/feishu:configure install-service` | (Re)install the systemd user service |
| `/feishu:configure uninstall-service` | Disable + remove the systemd service |
| `systemctl --user status claude-feishu` | Check daemon liveness |
| `journalctl --user -u claude-feishu -f` | Live daemon logs |
| `tmux attach -t claude-feishu` | Watch all spawned Y-b/L2 sessions |

### Permission requests

When Claude Code needs approval for a tool call (e.g., a destructive shell
command), the daemon posts the request in the thread for that session.
Reply in the thread with `y <code>` to allow or `n <code>` to deny — a
thumbs-up / thumbs-down reaction on your reply confirms the bot got it.

If the session hasn't created a thread yet (first-ever reply hasn't run),
the request goes to your hub chat instead.

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
