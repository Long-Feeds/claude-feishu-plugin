# Smoke Checklist — Multi-Session Feishu Bridge

Walk this list after deploying a fresh daemon or after changes that touch WS
event delivery, spawning, or IPC. The feishu-spawn / terminal / resume / restart items listed
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

### 4. feishu-spawn auto-spawn and auto-reply (full end-to-end)

```bash
send "告诉我当前工作目录"
```

Within ~15 seconds, expect:

```bash
# A new tmux window named fb:<ulid-prefix> exists:
tmux list-windows -t claude-feishu
# threads.json has a new entry with origin=feishu-spawn, status=active:
cat ~/.claude/channels/feishu/threads.json
# daemon logged the spawn + inject:
journalctl --user -u claude-feishu -n 50 | grep -E 'inbound event|spawnFeishu|injected feishu-spawn'
# The spawned claude auto-processed and called reply → thread has 2 messages:
lark-cli im +threads-messages-list --thread <new_thread_id> --as bot \
  | grep -E '"content"|"sender_type"'
```

Flow internals, for debugging:

- Feishu → daemon WS → `deliverFeishuEvent` → gate `deliver` → `spawnFeishu`
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

### 6. Multi-turn routing in a single thread (lark-cli automatable)

Sends N follow-up @mentions into an existing feishu-spawn thread and verifies that
each is routed to the same session and that Claude replies in sequence.

Use `lark-cli im +messages-reply --reply-in-thread` to keep the follow-ups
inside the existing topic (non-@ replies get gated by Feishu and never reach
the daemon — see §9 "Known rough edges"). The script below drives 3 rounds
after the initial feishu-spawn spawn:

```bash
TAG='<at user_id="'"$BOT_OPEN_ID"'">bot</at>'

# Round 1: spawn a fresh feishu-spawn session
R1=$(lark-cli im +messages-send --chat-id "$TEST_CHAT" \
  --text "$TAG 多轮测试 R1: 1+1 等于几" --as bot)
R1_ID=$(echo "$R1" | grep -oE 'om_[a-zA-Z0-9]+' | head -1)

# Give daemon a moment to log the spawn and capture the thread_id it assigned
sleep 5
THREAD=$(journalctl --user -u claude-feishu --no-pager --since='30 seconds ago' \
  | grep 'inbound event' | tail -1 \
  | grep -oE 'thread=omt_[a-zA-Z0-9]+' | cut -d= -f2)

count_replies() {
  lark-cli im +threads-messages-list --thread "$THREAD" --as bot 2>/dev/null \
    | grep -c '"id": "cli_<your-bot-app-id>"'   # sub your bot's app id
}

# Wait for Round 1 reply to land
until [ "$(count_replies)" -ge 1 ]; do sleep 3; done

send_round() {
  local n=$1 q=$2 want=$3
  lark-cli im +messages-reply --message-id "$R1_ID" \
    --text "$TAG $q" --reply-in-thread --as bot >/dev/null
  local start=$(date +%s)
  until [ "$(count_replies)" -ge "$want" ]; do
    [ $(($(date +%s) - start)) -gt 90 ] && { echo "R$n TIMEOUT"; return 1; }
    sleep 3
  done
  echo "R$n OK"
}

send_round 2 "R2: 再问一个，2+2?" 2
send_round 3 "R3: 3+3?" 3
send_round 4 "R4: 4+4?" 4

# Final dump — expect interleaved (lark-cli / bot) / (Claude Harness) pairs
lark-cli im +threads-messages-list --thread "$THREAD" --as bot \
  | grep -E '"content"|"id": "cli_'
```

Pass criteria:
- Each round's `inbound event` → `gate decision: deliver` → `entry FOUND` →
  **`send-keys inbound to claude-feishu:fb:<prefix>`** appears in
  `journalctl --user -u claude-feishu`.
- `threads.json` entry's `last_message_at` advances with each round, but
  `session_id` and `thread_id` stay fixed.
- The final thread dump shows alternating lark-cli prompt / Claude reply pairs.

> **Why send-keys, not MCP notification?** For feishu-spawn sessions, subsequent
> inbound messages are injected via `tmux send-keys` (same path as the
> initial prompt). Claude Code at an idle `❯` prompt after completing a
> turn silently drops `notifications/claude/channel` messages sent via MCP,
> so we route through the tmux pane instead. terminal sessions keep the MCP
> notification path since they don't have a daemon-owned pane.

### 7. Thread-reply routing from a real human account (not automated)

lark-cli can't trigger non-@ delivery because Feishu filters group events
to @mentions only for bot receivers. A human account's reply in the thread
(no @ needed) does arrive at the daemon — verify the same `inbound event →
entry FOUND → send-keys inbound` log sequence, and that Claude processes +
replies in-thread.

### 8. resume revival (not automated; needs human reply)

```bash
# Kill a feishu-spawn window manually:
tmux kill-window -t claude-feishu:fb:<id>
# Verify threads.json status flips to "inactive":
cat ~/.claude/channels/feishu/threads.json
# From a human account, reply in that thread.
# A new tmux window spawns in the same cwd. Claude processes as a fresh
# conversation (state-resume deferred until Claude Code exposes session uuid).
```

### 9. Daemon restart resilience

```bash
systemctl --user restart claude-feishu
# Watch shims reconnect automatically (exponential backoff, keeps session_id):
journalctl --user -u claude-feishu -f
# Send another @mention — it still routes correctly since shim re-registered
# with the original session_id and daemon rebound it from threads.json.
send "restart-check: 回个 ok"
```

### 10. Access-control tooling

```bash
/feishu:access threads                            # list all, grouped by status
/feishu:access thread close <thread_id>           # archive
send "reply in closed thread"                     # bot auto-replies "thread closed"
/feishu:access thread kill <thread_id>            # kills tmux window of active session
```

## Known rough edges

- **cwd is global** (`~/workspace` or `FEISHU_DEFAULT_CWD`). Per-chat or
  per-message cwd selection is planned but not in this release.
- **resume is conversation revival, not state resume.** Claude Code 2.1 doesn't
  expose its session UUID to MCP children, so resume runs a fresh session in
  the same cwd with the user's reply as the initial prompt. Shim already has
  the forward-compat hook for when this changes.
- **Topic-mode groups** auto-thread every root @mention → each is a new feishu-spawn
  session. If you want to keep one long thread, reply **into** that topic from
  your Feishu UI rather than starting a new top-level @mention.
- **lark-cli testing covers feishu-spawn only.** Thread replies (step 6) and resume revival
  (step 7) need a real user account to fire because Feishu gates group
  delivery to @mention events only, and lark-cli as another bot gets filtered.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `daemon: WebSocket connected` but no `inbound event` on @mention | Stray `bun server.ts` or another app instance holding the WSClient slot. `pkill -f 'bun server.ts'` and `systemctl --user restart claude-feishu`. |
| tmux window opens but instantly closes | Inside the window, claude exited non-zero. Usually PATH — check systemd unit has `Environment=PATH=${HOME}/.local/bin:${HOME}/.bun/bin:...`. |
| Window up, but prompt never submits | `tmux send-keys` Enter didn't land. Fix is already in daemon (split literal text + Enter with 300ms gap); if you see this, check the daemon log for `injected feishu-spawn initial into tmux window` and manually `tmux send-keys -t <session>:<window> Enter`. |
| Permission prompt blocks reply | `--dangerously-skip-permissions` missing from spawn argv. Check `src/spawn.ts`. |
| `no server running on /tmp/tmux-1001/default` after any op | tmux session `claude-feishu` had no windows and the server self-terminated. Next feishu-spawn spawn will `ensureTmuxSession` and recreate. Benign. |
