# Smoke Checklist — Multi-Session Feishu Bridge

Walk this list after deploying a fresh daemon or after changes that touch WS
event delivery, spawning, or IPC. The Y-b / X-b / L2 / restart items listed
below each have an "auto" path using `lark-cli` so they can be driven from a
script without a human at the Feishu app.

## Prereqs

- Feishu app with `im.message.receive_v1` subscribed in **long-connection**
  mode. App bot added to the test group.
- `~/.claude/channels/feishu/.env` has `FEISHU_APP_ID` + `FEISHU_APP_SECRET`.
- `bun`, `tmux`, `systemctl --user`, and `lark-cli` on `PATH`.
- Plugin installed via `claude plugin install feishu@claude-feishu`.
- For lark-cli-driven tests: a **separate** Feishu bot that can send into the
  test group (lark-cli's default bot is fine). Sending cross-app via user
  identity requires `lark-cli auth login --scope im:message.send_as_user`.

## Test harness variables

Replace for your environment:

```bash
BOT_OPEN_ID=ou_7604a4f0196467afdd57b1cfb714132a   # the bot powered by the daemon
TEST_CHAT=oc_7e62519348fcd9c524805fbb4819dd2f     # a group both bots belong to
at() { echo "<at user_id=\"$BOT_OPEN_ID\">bot</at>"; }
send() {
  lark-cli im +messages-send --chat-id "$TEST_CHAT" --text "$(at) $*" --as bot
}
```

## Checklist

### 1. Daemon install and boot

```bash
/feishu:configure install-service           # writes systemd unit, enables, starts
systemctl --user status claude-feishu       # Active: active (running)
journalctl --user -u claude-feishu -f       # expect: "daemon: WebSocket connected"
```

### 2. Pair + hub chat auto-set

1. DM the bot on Feishu → bot replies with a 6-char pairing code.
2. `/feishu:access pair <code>` in terminal.
3. Verify:
   ```bash
   cat ~/.claude/channels/feishu/access.json
   ```
   `allowFrom` includes your `open_id`; `hubChatId` is set to the DM's `chat_id`
   (auto-populated by pair when unset).

### 3. Whitelist the test group

```bash
# Edit access.json groups entry so daemon accepts events from TEST_CHAT.
# requireMention=true means the bot only responds when @mentioned,
# which is also what Feishu's event subscription delivers for group chats.
```
Resulting `groups` entry:
```json
"groups": {
  "oc_7e62519348fcd9c524805fbb4819dd2f": { "requireMention": true, "allowFrom": [] }
}
```

### 4. Y-b auto-spawn and auto-reply (full end-to-end)

```bash
send "告诉我当前工作目录"
```

Within ~15 seconds, expect:

```bash
# A new tmux window named fb:<ulid-prefix> exists:
tmux list-windows -t claude-feishu
# threads.json has a new entry with origin=Y-b, status=active:
cat ~/.claude/channels/feishu/threads.json
# daemon logged the spawn + inject:
journalctl --user -u claude-feishu -n 50 | grep -E 'inbound event|spawnYb|injected Y-b'
# The spawned claude auto-processed and called reply → thread has 2 messages:
lark-cli im +threads-messages-list --thread <new_thread_id> --as bot \
  | grep -E '"content"|"sender_type"'
```

Flow internals, for debugging:

- Feishu → daemon WS → `deliverFeishuEvent` → gate `deliver` → `spawnYb`
- Daemon stores triggering meta in `pendingYbInbound[session_id]`
- `tmux new-window ... claude --dangerously-skip-permissions`
- After 5s, daemon `tmux send-keys -l <channel source="feishu" chat_id=...>text</channel>`
  then 300ms later `tmux send-keys Enter`
- Claude reads the `<channel>` tag, processes the prompt, calls the `reply`
  tool with `chat_id` and `reply_to` from the tag (permission prompt skipped)
- Daemon's reply handler lands the message in the same thread

### 5. Multiple parallel sessions

```bash
send "任务 A：列出这个目录的文件"
send "任务 B：告诉我现在的时间"
```

Two new tmux windows + two new `threads.json` entries, each with its own
`session_id` and `thread_id`. Later thread-replies route to the correct
session regardless of which came first.

### 6. Thread-reply routing (subsequent messages in the same topic)

This requires a real user reply in the thread — lark-cli as a different bot
gets filtered by Feishu (group events only fire on @mention to the bot). From
a human account, reply in one of the threads. The matching Y-b session sees
the message as an MCP channel notification (via `push:inbound` → shim →
`notifications/claude/channel`). Claude auto-processes + replies in-thread.

### 7. L2 revival (not automated; needs human reply)

```bash
# Kill a Y-b window manually:
tmux kill-window -t claude-feishu:fb:<id>
# Verify threads.json status flips to "inactive":
cat ~/.claude/channels/feishu/threads.json
# From a human account, reply in that thread.
# A new tmux window spawns in the same cwd. Claude processes as a fresh
# conversation (state-resume deferred until Claude Code exposes session uuid).
```

### 8. Daemon restart resilience

```bash
systemctl --user restart claude-feishu
# Watch shims reconnect automatically (exponential backoff, keeps session_id):
journalctl --user -u claude-feishu -f
# Send another @mention — it still routes correctly since shim re-registered
# with the original session_id and daemon rebound it from threads.json.
send "restart-check: 回个 ok"
```

### 9. Access-control tooling

```bash
/feishu:access threads                            # list all, grouped by status
/feishu:access thread close <thread_id>           # archive
send "reply in closed thread"                     # bot auto-replies "thread closed"
/feishu:access thread kill <thread_id>            # kills tmux window of active session
```

## Known rough edges

- **cwd is global** (`~/workspace` or `FEISHU_DEFAULT_CWD`). Per-chat or
  per-message cwd selection is planned but not in this release.
- **L2 is conversation revival, not state resume.** Claude Code 2.1 doesn't
  expose its session UUID to MCP children, so resume runs a fresh session in
  the same cwd with the user's reply as the initial prompt. Shim already has
  the forward-compat hook for when this changes.
- **Topic-mode groups** auto-thread every root @mention → each is a new Y-b
  session. If you want to keep one long thread, reply **into** that topic from
  your Feishu UI rather than starting a new top-level @mention.
- **lark-cli testing covers Y-b only.** Thread replies (step 6) and L2 revival
  (step 7) need a real user account to fire because Feishu gates group
  delivery to @mention events only, and lark-cli as another bot gets filtered.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `daemon: WebSocket connected` but no `inbound event` on @mention | Stray `bun server.ts` or another app instance holding the WSClient slot. `pkill -f 'bun server.ts'` and `systemctl --user restart claude-feishu`. |
| tmux window opens but instantly closes | Inside the window, claude exited non-zero. Usually PATH — check systemd unit has `Environment=PATH=${HOME}/.local/bin:${HOME}/.bun/bin:...`. |
| Window up, but prompt never submits | `tmux send-keys` Enter didn't land. Fix is already in daemon (split literal text + Enter with 300ms gap); if you see this, check the daemon log for `injected Y-b initial into tmux window` and manually `tmux send-keys -t <session>:<window> Enter`. |
| Permission prompt blocks reply | `--dangerously-skip-permissions` missing from spawn argv. Check `src/spawn.ts`. |
| `no server running on /tmp/tmux-1001/default` after any op | tmux session `claude-feishu` had no windows and the server self-terminated. Next Y-b spawn will `ensureTmuxSession` and recreate. Benign. |
