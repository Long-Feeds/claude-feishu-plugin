# Manual Smoke Checklist — Multi-Session Feishu Bridge

Walk this list after deploying the new daemon/shim architecture (or after
any change that touches WS event delivery, spawning, or IPC). Each item is
a user-visible behavior — the unit/integration tests cover internals.

## Prereqs

- Feishu app configured (APP_ID/APP_SECRET in `~/.claude/channels/feishu/.env`)
- `bun`, `tmux`, and `systemctl --user` available
- Plugin installed via `claude plugin install feishu@claude-feishu`

## Checklist

1. **Daemon install**
   - Run `/feishu:configure install-service` in Claude Code.
   - `systemctl --user status claude-feishu` shows `active (running)`.
   - `journalctl --user -u claude-feishu -f` prints "daemon: WebSocket connected".

2. **First pair**
   - DM the bot on Feishu → receive 6-char code.
   - `/feishu:access pair <code>` → receive "Paired" confirmation.
   - Verify `access.json` has your `open_id` in `allowFrom` and `hubChatId`
     set to the DM chat (may be implicit if you added set-hub).

3. **Y-b flow (top-level message spawns a session)**
   - DM bot: "hello claude".
   - A new tmux window appears in session `claude-feishu` (verify with
     `tmux list-windows -t claude-feishu`).
   - Shim registers; Claude sees initial prompt "hello claude".
   - Claude's first `reply` lands in a NEW thread rooted on your DM message.

4. **X-b flow (local session joins the bridge)**
   - In another terminal: `cd ~/workspace/someproj && claude`.
   - Ask Claude something that prompts a `reply` call (e.g., "ping me on
     Feishu when you're done").
   - First reply → a new thread in the hub chat (the DM you paired with).
   - Second reply in the same session → lands in the same thread.

5. **Thread-reply routing**
   - In either thread, send "add unit tests" from Feishu.
   - The targeted Claude session receives it as an MCP channel notification.

6. **L2 resume**
   - Kill the Y-b tmux window: `tmux kill-window -t claude-feishu:fb:<id>`.
   - Send a reply in that thread's history.
   - A new tmux window spawns; `claude --resume <uuid>` runs in the same cwd.
   - `threads.json` shows status back to `active`.

7. **Daemon restart resilience**
   - `systemctl --user restart claude-feishu`.
   - Within a few seconds, shims reconnect (watch `journalctl`).
   - Replies in existing threads continue to route correctly.

8. **Access control**
   - `/feishu:access threads` lists all threads grouped by status.
   - `/feishu:access thread close <thread_id>` archives a thread.
   - Reply in a closed thread → "thread closed" auto-response.
   - `/feishu:access thread kill <thread_id>` kills a running tmux window;
     daemon auto-flips status to inactive.

## What to watch for

- tmux windows not appearing → check `journalctl` for "tmux not installed"
  or spawn errors.
- Shim connect errors → `systemctl --user status claude-feishu`; if daemon
  down, start it.
- Duplicate events → only one WSClient should be live. If you're testing
  `bun src/daemon.ts` manually, stop the systemd service first.
