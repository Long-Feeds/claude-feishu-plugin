# Access Control

The Feishu channel implements a layered access control system that determines
who can send messages to your Claude Code session. All state lives in a single
file — `~/.claude/channels/feishu/access.json` — managed by the
`/feishu:access` skill.

## DM Policies

Three modes for direct messages:

### `pairing` (default)

When an unknown user DMs the bot:
1. Bot generates a 6-character hex code and replies with it.
2. The code expires after 1 hour; at most 2 replies before going silent.
3. Maximum 3 pending pairings at a time.
4. User approves in Claude Code: `/feishu:access pair <code>`
5. Bot sends confirmation; sender is added to the allowlist.

This is a **bootstrap mode** — use it to capture open_ids, then switch to
`allowlist`.

### `allowlist` (recommended)

Only senders whose `open_id` is in the `allowFrom` array can reach Claude Code.
Unknown senders are silently ignored — no pairing codes, no responses.

### `disabled`

All DMs rejected.

## Group Support

Groups require explicit opt-in:

```
/feishu:access group add <chat_id>
/feishu:access group add <chat_id> --no-mention
/feishu:access group add <chat_id> --allow ou_xxx,ou_yyy
```

Options:
- `requireMention` (default: true) — bot only responds when @-mentioned.
- `allowFrom` — restrict to specific senders within the group. Empty = all
  group members.

Remove a group: `/feishu:access group rm <chat_id>`

## State File Format

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["ou_abc123", "ou_def456"],
  "groups": {
    "oc_group123": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "pending": {},
  "ackReaction": "THUMBSUP",
  "replyToMode": "first",
  "textChunkLimit": 4000,
  "chunkMode": "length",
  "mentionPatterns": ["@mybot"]
}
```

## Delivery Settings

Configure via `/feishu:access set <key> <value>`:

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `ackReaction` | Feishu emoji type name or `""` | none | React on receipt (e.g., `THUMBSUP`) |
| `replyToMode` | `off` / `first` / `all` | `first` | Which chunks get reply threading |
| `textChunkLimit` | number | 4000 | Max chars per outbound message |
| `chunkMode` | `length` / `newline` | `length` | Split strategy for long messages |
| `mentionPatterns` | JSON array of regex | none | Additional mention patterns |

## Security Notes

- **Sender IDs are open_ids** — app-scoped, stable identifiers. They cannot be
  changed by the user.
- **Access mutations are terminal-only** — the `/feishu:access` skill only runs
  from user commands in the terminal, never from channel messages.
- **Outbound gate** — the `reply` tool can only target chats that have passed
  the inbound gate.
- **State file protection** — the `reply` tool refuses to send files from the
  channel state directory (except `inbox/`).
- **Static mode** — set `FEISHU_ACCESS_MODE=static` to freeze access config at
  boot time. Pairing is downgraded to allowlist.

## Permission Relay

When Claude Code needs approval for a tool call, the channel sends a text
message to all allowlisted users with the request details and a permission code.
Reply with `y <code>` to allow or `n <code>` to deny.
