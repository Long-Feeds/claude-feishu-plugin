# Multi-Session Feishu Bridge — Design

- **Date**: 2026-04-21
- **Status**: Draft — pending user review before implementation planning
- **Author**: brainstormed in session with lonlonagoo

## 1. Context

Today the Feishu plugin (`server.ts`) is a single-file MCP server launched
per Claude Code session via `.mcp.json`. Each session owns its own
`WSClient` and its own mapping from Feishu chats to Claude. This works for
one session but breaks when the user runs many Claude sessions in parallel:

- Feishu delivers each event to **one** connected WSClient per APP_ID
  (documented gotcha in `CLAUDE.md`). Multiple sessions competing for the
  WebSocket means events land on whichever session won the race.
- There is no per-session identity in Feishu — every message goes to the
  same DM / group regardless of which terminal it came from.

### Target scenario

The user runs N parallel Claude sessions across different repos/tasks.
Each session should:

1. Have its own Feishu **thread** (话题) so updates and conversations stay
   isolated. Feishu supports native threads rooted on any message in any
   chat type (DM, normal group, topic group), so we use `thread_id` as the
   routing key.
2. Post updates and accept user replies bidirectionally within that thread.
3. Allow the user to send a **top-level** message in Feishu to spawn a brand
   new Claude session automatically.
4. Allow the user to reply in an **old (archived)** thread to revive a dead
   session (resume into the same cwd).

## 2. Goals / Non-goals

### In scope

- Multi-session routing: one `thread_id → session_id` map, many concurrent sessions.
- Auto-spawn on top-level Feishu message (`Y-b`: new tmux window, headful Claude process).
- Auto-attach on `claude` start (`X-b`: any local Claude session joins the bridge without flags).
- L2 thread lifecycle: dead threads can be revived by the user replying in them.
- systemd `--user` managed daemon (`D-b`); one daemon per user per machine.
- Full access-control semantics preserved (pairing / allowlist / groups).

### Out of scope (explicit)

- Cross-machine daemon sharing. Each host runs its own daemon against its
  own Feishu app; no federation.
- Multiple Feishu apps per daemon.
- GUI / web dashboard for thread management. All control is CLI/skill-based.
- Strict per-user permission scoping in L2 threads (see §7.4 open questions).

### Fallback scope

If `X-b` proves infeasible (e.g., channel plugin can't auto-load without
`--dangerously-load-development-channels`), degrade to `X-a`: user still
passes the flag on `claude` launch. Y-b is unaffected.

## 3. Architecture overview

### 3.1 Topology

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
```

### 3.2 Process roles

| Process | Count | Launch | Responsibility |
|---|---|---|---|
| **daemon** | 1 per user | `systemctl --user start claude-feishu` | Sole owner of WSClient; all Feishu API egress; thread/session routing; spawns Y-b sessions |
| **shim** | N (one per Claude session) | Auto-launched by Claude Code via `.mcp.json` | Translates MCP stdio ↔ daemon socket; registers session identity; relays notifications |
| **Claude session** | N | User `claude` (X-b) / daemon `tmux new-window` (Y-b) | Standard Claude Code process; uses Feishu via shim |

### 3.3 State directory

All state lives in `~/.claude/channels/feishu/`:

| File | Content | Writer |
|---|---|---|
| `.env` | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `/feishu:configure` |
| `access.json` | pairing / allowlist / groups (existing schema, unchanged) | `/feishu:access` + daemon |
| `threads.json` | **new**: `thread_id → {session_id, cwd, chat_id, ...}` | daemon |
| `daemon.sock` | Unix socket (mode 0600) | daemon |
| `daemon.pid` | pid file (fallback if systemd isn't present) | daemon |
| `approved/` | pairing handoff (existing) | both |
| `inbox/` | downloaded attachments | daemon (writes), shim (reads path) |

### 3.4 Key invariants

- Only the daemon talks to the Feishu Open API. Shims never open a WSClient, never call Feishu directly.
- Only one daemon per user per host at a time (enforced via pid file + socket existence check).
- `systemd` is the normal supervisor; pidfile is a belt-and-suspenders for manual runs.
- tmux session name defaults to `claude-feishu`; override via env `FEISHU_TMUX_SESSION`.
- **Hub chat** is an explicit field (`hubChatId`) stored in `access.json`.
  `/feishu:configure` sets it on first successful pair (the chat_id of the
  DM that paired in). `/feishu:configure set-hub <chat_id>` overrides it
  later. If unset and an X-b session calls `reply`, the shim returns an
  MCP error "no Feishu hub chat configured — DM the bot first".

## 4. Data flow

### 4.1 Outbound: first `reply` from an X-b session (lazy thread creation)

```
Claude ──MCP: reply{chat_id?, text, files?, reply_to?}──▶ shim
                                                           │
                                                           │ shim has no local thread_id
                                                           │
                ──NDJSON: {"op":"reply",                   │
                   "session_id":"...",                     │
                   "text":"...",                           │
                   "files":[...]}───────────────────▶ daemon
                                                           │
                daemon looks up threads.json:             │
                  session_id → thread? → not found        │
                  ↓                                        │
                daemon decides chat_home:                  │
                  X-b → hub_chat_id (configured)           │
                  Y-b → triggering chat                    │
                  ↓                                        │
                daemon calls Feishu (X-b path):            │
                  im.message.create(receive_id=chat_home,  │
                    msg_type=text, content=text)           │
                  → message_id = m1 (root; no thread yet)  │
                  daemon records session → m1 binding,     │
                  defers threads.json until thread_id      │
                  materializes on next in-thread reply.    │
                                                           │
                (Y-b path differs: daemon uses             │
                 im.message.reply on the triggering        │
                 message m0 with reply_in_thread=true,     │
                 which returns thread_id directly.)        │
                  ↓                                        │
                daemon writes threads.json once            │
                thread_id is known:                        │
                  { t1: { session_id, cwd, chat_id, ...} } │
                  ↓                                        │
                ◀────{"ok":true,"thread_id":"t1",          │
                     "message_id":"m1"}─────────── daemon
  shim caches thread_id=t1
  returns to Claude MCP: "sent (id: m1)"
```

Subsequent replies on the same session take the cached `thread_id` and hit
`im.message.reply` with `reply_in_thread=true` so they land in the same thread.

**X-b thread bootstrap note**: Feishu does not create a thread on a plain
`im.message.create` — thread_id only materializes on the first reply that
uses `reply_in_thread=true`. So X-b's first Claude reply produces a
rootless m1; the *second* reply is what creates the thread. Until then,
inbound events from the user in that chat (if any) don't carry a thread_id
and will be treated as new top-level messages. This race is the same
phenomenon covered under §7.3 "Y-b spawn race" and is handled the same way
(do not merge).

### 4.2 Inbound: user replies in an active thread

```
user replies "add unit tests" in thread t1
          │
          ▼
Feishu WSS ───im.message.receive_v1 (thread_id=t1)──▶ daemon
                                                          │
                                          daemon routes:  │
                                            access gate → pass
                                            threads.json → session #42, shim live
                                            ↓
                                          daemon ──{"push":"inbound",
                                                    "content":"add unit tests",
                                                    "meta":{...}}──▶ shim #42
                                                                     │
                                          shim → MCP notification:   │
                                          notifications/claude/channel ▶ Claude #42
                                                                     │
                                          Claude handles it normally.
```

### 4.3 Inbound: top-level message → spawn Y-b session

```
user sends DM "look into the flaky test in ~/workspace/foo"
          │
          ▼
Feishu WSS ─────▶ daemon
                    │
                    gate: DM allowlisted ✓, no thread_id ✓
                    ↓
                    daemon decides: new top-level → Y-b spawn
                    ↓
                    daemon generates session_id = ulid()
                    ↓
                    daemon spawns:
                      tmux new-window -t claude-feishu -n "fb:<8char>" \
                        -c ~/workspace \
                        env FEISHU_SESSION_ID=<id> \
                            FEISHU_INITIAL_PROMPT=<base64 of msg> \
                            claude
                    ↓
                    (claude starts → loads plugin → shim spawns → shim
                     opens daemon.sock, sends register with session_id)
                    ↓
                    daemon sees register, binds shim conn to session_id,
                    marks origin=Y-b, stores triggering chat_id as thread home.
                    ↓
                    daemon ──{"push":"initial_prompt", content=prompt}──▶ shim
                                                                           │
                                                                 shim → MCP notification
                                                                           │
                                                                           ▼
                                                                   Claude reads prompt,
                                                                   begins work.
                    ↓
                    Claude's first reply → as in §4.1; the thread is
                    rooted on message m0 (the user's triggering message)
                    via Feishu's reply_in_thread=true, not on a new root.
```

The default spawn cwd is `~/workspace` (overridable via env
`FEISHU_DEFAULT_CWD`). The daemon never parses the message text to infer
cwd — that would be both unreliable and a minor prompt-injection surface.

### 4.4 Inbound: user replies in an *inactive* thread (L2 resume)

```
user replies "keep digging" in thread t1 (session already exited)
          │
          ▼
Feishu WSS ─────▶ daemon
                    │
                    threads.json: t1 → session_id, cwd, status=inactive
                    ↓
                    daemon reacts ⏳ to the inbound message (tells user "waking up")
                    ↓
                    daemon spawns:
                      tmux new-window -t claude-feishu \
                        -c <cwd> \
                        env FEISHU_SESSION_ID=<old_id> \
                            FEISHU_RESUME_UUID=<claude_session_uuid> \
                            FEISHU_INITIAL_PROMPT=<base64 inbound content> \
                        bash -c 'claude --resume "$FEISHU_RESUME_UUID" || \
                                 (echo "[resume-fail:$?]"; sleep 30)'
                    ↓
                    daemon waits up to 3s for shim register
                    ↓
                    success → deliver inbound as notification, remove ⏳, status=active
                    failure → daemon posts in thread t1:
                      "resume failed (<reason>); send a new top-level message
                       for a fresh session." Thread stays `inactive`.
```

## 5. Thread state model & L2 resume

### 5.1 `threads.json` schema

```jsonc
{
  "version": 1,
  "threads": {
    "<thread_id>": {
      "session_id": "01HXY...",              // daemon-assigned ULID, routing key
      "claude_session_uuid": "abc-123-...",  // Claude Code session id (for --resume)
      "chat_id": "oc_xxx",                   // chat containing the thread
      "root_message_id": "om_xxx",           // root of thread
      "cwd": "/home/user/workspace/foo",
      "origin": "X-b" | "Y-b",
      "status": "active" | "inactive" | "closed",
      "last_active_at": 1713686400000,
      "last_message_at": 1713686500000,
      "spawn_env": {
        "FEISHU_SESSION_ID": "01HXY...",
        "tmux_window_name": "fb:01HXY..."
      }
    }
  }
}
```

In-memory only (not persisted):
- `session_id → thread_id`
- `session_id → shim_conn` (socket handle)
- `active_sessions: Set<session_id>`

### 5.2 State machine

```
          ┌─────────────────────────────────────────┐
          ▼                                         │
      [nonexistent]                                 │
          │ shim first reply / Y-b trigger          │
          │ daemon creates root msg + threads.json  │
          ▼                                         │
      [active]  ◀─────── shim reconnect (resume) ───┤
          │                                         │
          │ shim EOF / Claude exits                 │
          ▼                                         │
      [inactive]                                    │
          │                                         │
          │ user replies in thread                  │
          │ daemon tmux new-window + claude --resume │
          └─────────────────────────────────────────┘

      [inactive] ─── /feishu:access thread close ──▶ [closed]
      [closed]   → any reply gets one auto-response "thread closed"
```

### 5.3 Session UUID TBD

`claude_session_uuid` is load-bearing for L2 resume. Verify during
implementation, in this order:

1. **Path 1 (preferred)**: MCP `initialize` response exposes session id →
   shim reads it → reports back via `op:session_info` to daemon.
2. **Path 2**: Claude Code honors an env var (e.g., `CLAUDE_SESSION_UUID`)
   → daemon pre-assigns and injects at spawn time.
3. **Path 3 (degrade)**: Neither is supported → redefine L2 as "same-cwd
   continuation with a context summary prompt", not a strict state resume.
   The design doc calls out that L2 is a *conversation-level* revival,
   not a memory-level one.

This TBD is tracked in §7 and must be resolved before the writing-plans skill
commits to an implementation path.

## 6. IPC protocol (shim ↔ daemon)

### 6.1 Transport

- Unix domain socket: `~/.claude/channels/feishu/daemon.sock`, mode `0600`.
- One NDJSON message per line.
- Long-lived connection per shim; EOF → shim dead.
- No auth on the wire — socket permissions (and the user-private directory) are the trust boundary.

### 6.2 Message catalog

**shim → daemon** (each request has an `id` for response matching):

```jsonc
// register (first line after connect)
{"id":1,"op":"register","session_id":null,"pid":12345,"cwd":"/home/user/workspace/foo"}
// daemon response: allocates a new session_id
{"id":1,"ok":true,"session_id":"01HXYABC...","thread_id":null}

// register with existing session_id (resume)
{"id":1,"op":"register","session_id":"01HXYABC...","pid":12345,"cwd":"..."}
{"id":1,"ok":true,"session_id":"01HXYABC...","thread_id":"omt_xxx"}

// tool invocations (mapped 1:1 from MCP tool calls)
{"id":2,"op":"reply","text":"done","files":[],"format":"text","reply_to":null}
{"id":2,"ok":true,"message_id":"om_xxx","thread_id":"omt_xxx"}

{"id":3,"op":"react","message_id":"om_xxx","emoji_type":"THUMBSUP"}
{"id":4,"op":"edit_message","message_id":"om_xxx","text":"...","format":"text"}
{"id":5,"op":"download_attachment","message_id":"om_xxx","file_key":"...","type":"image"}

// permission request passthrough (from Claude MCP notification)
{"id":6,"op":"permission_request","request_id":"abcde","tool_name":"...","description":"...","input_preview":"..."}
{"id":6,"ok":true}

// optional: report claude session uuid (path 1 above)
{"id":7,"op":"session_info","claude_session_uuid":"..."}
```

**daemon → shim** (pushes, no id correlation):

```jsonc
// inbound from user
{"push":"inbound","content":"...","meta":{
  "chat_id":"oc_xxx","message_id":"om_xxx","thread_id":"omt_xxx",
  "user":"ou_xxx","ts":"2026-04-21T...",
  "image_path":"...optional...",
  "attachment_file_key":"...optional...","attachment_kind":"...optional..."
}}

// initial prompt (Y-b spawn / L2 resume)
{"push":"initial_prompt","content":"..."}

// permission reply resolved via thread (user typed "y abcde")
{"push":"permission_reply","request_id":"abcde","behavior":"allow"|"deny"}

// daemon restarting / shutting down
{"push":"shutdown","reason":"daemon restarting"}
```

### 6.3 MCP ↔ IPC mapping

| Claude MCP | shim action | daemon work |
|---|---|---|
| `tools/call reply` | `op:reply` | Feishu API; first call creates thread; writes threads.json |
| `tools/call react` | `op:react` | Feishu reaction API |
| `tools/call edit_message` | `op:edit_message` | Feishu patch API |
| `tools/call download_attachment` | `op:download_attachment` | daemon downloads into inbox, returns path |
| notif `permission_request` | `op:permission_request` | daemon posts prompt in thread (or hub if no thread yet) |
| (daemon push) `push:inbound` | notif `notifications/claude/channel` | — |
| (daemon push) `push:initial_prompt` | notif `notifications/claude/channel` | — |

The shim does not declare its own MCP tool list — it forwards
`tools/list` straight from daemon (or, pragmatically, hardcodes the same
four tools that exist today; see §8 implementation notes).

### 6.4 Session identity binding

- **X-b**: shim `register` with `session_id=null` → daemon allocates ULID,
  returns it, stores in in-memory `active_sessions`. No entry in
  threads.json yet (thread doesn't exist).
- **Y-b**: daemon allocates ULID before `tmux new-window` and injects via
  `FEISHU_SESSION_ID` env. shim registers with that id; daemon binds.
- **L2 resume**: same as Y-b, but the id is the old one; daemon looks it
  up in threads.json to find the thread and rebinds.

### 6.5 Reconnection semantics

- **shim EOF** (Claude exits): daemon removes entry from `active_sessions`;
  if the session had a thread, that thread's `status := inactive`.
- **daemon restart**: all shims see socket EOF; each shim backs off
  exponentially (100ms → 30s cap) and retries with the **same** session_id.
  daemon, after startup, looks up each re-registration in threads.json and
  rebinds.
- **During shim reconnect**: shim buffers up to 64 pending MCP requests;
  beyond that, MCP returns error "daemon temporarily unavailable, retry".
- **Offline events during daemon downtime**: relies on Feishu SDK's WSS
  resume cursor. Best-effort; not a hard guarantee. Not separately queued
  by us.

### 6.6 Concurrency

- Per-session serial: one in-flight request per shim connection; matches MCP blocking semantics.
- Cross-session parallel: independent socket per shim, fully concurrent.
- `threads.json` writes are atomic (temp + rename), same pattern as existing `saveAccess`.

## 7. Error handling & edge cases

### 7.1 Daemon-side failures

| Scenario | Behavior |
|---|---|
| WSClient disconnect | SDK auto-reconnects. Log state changes to stderr. After 5 consecutive failures, daemon posts "⚠️ 飞书连接暂时中断" once to each active thread's hub chat. No backfill on recovery. |
| WSClient preemption (another process steals the WS slot) | Feishu admits the new client and evicts us. daemon detects the disconnect reason → exit(1); systemd restarts; daemon logs "possible duplicate WSClient — check for stray processes". If the other client keeps winning, `systemd` will back off. |
| Feishu API call failure (reply/react/etc.) | No retry; error returned to shim, shim returns `isError: true` to Claude (same as current plugin). |
| Thread creation failure (first reply) | shim doesn't cache thread_id; threads.json not written; next reply tries again. |
| daemon process crash | systemd `Restart=on-failure`. pidfile check on startup: live pid → refuse to start; dead pid → clean up and proceed. |
| Stale socket at startup | If pid is live, refuse; if dead, `rm -f` the socket and rebuild. |
| Corrupt `threads.json` | Rename to `.corrupt-<ts>`, log warning, start from empty (same pattern as `access.json`). Old threads become orphans; user reply in them gets "thread not tracked". |

### 7.2 Shim / session-side failures

| Scenario | Behavior |
|---|---|
| shim can't reach daemon | Exponential backoff 5 tries → give up; MCP returns "feishu daemon not running — try `systemctl --user start claude-feishu`". Claude functions normally minus Feishu tools. |
| shim registers but conflict (session_id in threads.json is closed, etc.) | shim returns MCP error; Feishu tools disabled for that session. |
| Claude crash / Ctrl-C | stdio closes → shim exits → daemon EOF → session marked inactive → thread L2. |
| tmux session `claude-feishu` doesn't exist | daemon creates it first with `tmux new-session -d -s claude-feishu`. If tmux itself is missing, daemon posts in trigger chat: "tmux not installed; please install or set FEISHU_SPAWN_CMD". |
| L2 resume cwd deleted | daemon `stat(cwd)` fails → posts "cwd `<path>` no longer exists; archiving" → thread becomes `closed`. |
| `claude --resume <uuid>` exits non-zero | Caught via `[resume-fail:$?]` sentinel in the bash wrapper. daemon posts "resume failed (exit=X); send a new top-level message for a fresh session." Thread stays `inactive`. |

### 7.3 Routing / state consistency

| Scenario | Behavior |
|---|---|
| Inbound `thread_id` not in threads.json | Drop, log debug (probably foreign/stale). |
| Same `session_id` registers twice | Evict the earlier connection; log warning. Normal during shim reconnect races. |
| Binding conflict (register says session X, threads.json has X → Y) | register wins; threads.json updated. Normal L2 path. |
| Y-b spawn race (two top-level messages <2s apart) | Do not merge. Each spawns its own session/thread; user manages. |
| Duplicate WSS events | Existing `recentEventIds` dedup (60s TTL). |

### 7.4 Security

| Scenario | Behavior |
|---|---|
| Shim forges session_id on register | Not defended. Trust boundary is socket mode `0600` in user-private dir. |
| Prompt injection inside Feishu messages | Existing MCP `instructions` + `/feishu:access` terminal-only policy. daemon never changes access control based on message content. |
| Permission "y xxxxx" reply by non-owner in a group/L2 thread | Accepted from any allowlisted user. Future work: scope to `thread.creator_open_id`. |
| Y-b env injection | `FEISHU_INITIAL_PROMPT` is base64 to neutralize special chars; cwd comes only from env/defaults, never parsed from message body. |

### 7.5 Operations & observability

| Need | Solution |
|---|---|
| daemon status | `systemctl --user status claude-feishu`; `journalctl --user -u claude-feishu -f` |
| list active sessions / threads | New `/feishu:access threads` subcommand reads threads.json |
| kill a session | `/feishu:access thread kill <thread_id>` → daemon sends Ctrl-C / `tmux kill-window` |
| archive a thread | `/feishu:access thread close <thread_id>` → threads.json status=closed |
| debug IPC | `FEISHU_LOG=debug` dumps IPC stream to stderr on both sides |

## 8. Testing & migration

### 8.1 Test layers

**Unit (pure functions, no Feishu / tmux)**

- `gate()` routing decisions across access.json permutations, including thread cases.
- `router(event)`: thread exists / unknown / Y-b / L2 branches.
- `threads.json` load/save: atomic write, corruption recovery, concurrent writes.
- IPC parser: ser/deser for every `op`, including error shapes.

**Integration (real daemon process + fake WSClient + fake shim)**

Harness:
- Mock WSClient: inject Feishu events straight into the daemon's event handler.
- Fake shim: plain socket client that drives register/reply/inbound cycles.
- Fake tmux: env `FEISHU_SPAWN_CMD=echo` to assert daemon composed the right command.

Cases:
1. X-b first reply creates thread, row appears in threads.json.
2. Y-b trigger spawns, shim registers, `initial_prompt` delivered.
3. User thread reply routes to correct shim.
4. shim EOF flips status to inactive.
5. Reply in inactive thread triggers L2 resume path.
6. daemon restart → shim reconnects with same session_id → binding recovered.

**Smoke (real Feishu, manual)**

Checklist to walk a fresh install:

1. `/feishu:configure install-service` → systemd up.
2. First pair → DM "Paired".
3. First `claude` (plugin installed) → DM triggers Y-b → tmux window appears, thread created.
4. Second `claude` started locally in a terminal → it calls `reply` → new thread in hub.
5. Manually kill the tmux window → reply in its old thread → L2 resume spawns new window.
6. `systemctl --user restart claude-feishu` → shim reconnects, business as usual.

Keep existing `test-ws.ts` as a single-channel WSS smoke test; do not expand its scope.

### 8.2 Code layout

Split from the current `server.ts` monolith:

```
claude-feishu-plugin/
├── .claude-plugin/plugin.json
├── .mcp.json                    # launches shim, not server
├── package.json                 # + scripts: daemon, shim
├── src/
│   ├── daemon.ts                # systemd process; WSClient + gate + router
│   ├── shim.ts                  # MCP stdio ↔ socket bridge (<300 lines)
│   ├── ipc.ts                   # NDJSON protocol + types (shared)
│   ├── access.ts                # lifted from server.ts, semantics unchanged
│   ├── threads.ts               # threads.json r/w + state machine
│   ├── spawn.ts                 # tmux + env wrapper
│   └── feishu-api.ts            # reply/react/edit/download wrappers (daemon)
├── skills/
│   ├── configure/SKILL.md       # + install-service subcommand
│   └── access/SKILL.md          # + threads / thread close / thread kill
├── systemd/
│   └── claude-feishu.service.tmpl   # ExecStart=bun <plugin-root>/src/daemon.ts
└── test-ws.ts                   # kept
```

`.mcp.json` shifts from `start` to `shim`:

```jsonc
{"mcpServers":{"feishu":{"command":"bun","args":["run","--cwd","${CLAUDE_PLUGIN_ROOT}","--silent","shim"]}}}
```

`package.json` scripts:

```jsonc
{"scripts":{
  "daemon":"bun install --no-summary && bun src/daemon.ts",
  "shim":"bun src/shim.ts"
}}
```

### 8.3 Migration from current single-session deployment

Existing users have `.env` + `access.json` + an already-paired DM.

Upgrade steps:

1. `/feishu:configure install-service` writes `~/.config/systemd/user/claude-feishu.service`, runs `systemctl --user daemon-reload && systemctl --user enable --now claude-feishu`.
2. daemon starts, reads existing `.env` + `access.json` (no schema change).
3. `threads.json` doesn't exist → initialized empty. The pre-existing paired DM naturally becomes the hub chat.
4. Next `claude` launch follows the new `.mcp.json`, loading the shim.

Rollback:

1. `systemctl --user disable --now claude-feishu`.
2. Swap `.mcp.json` back to `start`.
3. Old `server.ts` still runs unchanged — `access.json` is untouched.

Prereqs the README must call out:

- `tmux` installed (for Y-b / L2 resume window spawning).
- `bun` available in the systemd user service PATH (may require explicit
  `Environment="PATH=..."` in the unit file).

### 8.4 Explicit out-of-scope reiteration

- Cross-machine daemon.
- Multiple Feishu apps per daemon.
- Web/GUI for thread browsing.
- Per-thread custom message-length chunking abstractions (reuse existing `textChunkLimit`).
- Per-user permission scoping inside L2 threads.

## 9. Open questions (track in writing-plans)

1. **Claude Code session UUID retrieval** (§5.3). Verify path 1 → path 2 → path 3 during the implementation spike. The design tolerates any outcome but the UX differs.
2. **Initial prompt injection mechanism** (§4.3). Preferred path: MCP notification
   from shim after it's connected. If Claude Code needs a different vehicle
   (env-driven first user message, for instance), adapt without redesigning.
3. **Channel plugin auto-load without the `--dangerously-load-development-channels` flag**. X-b assumes this works once the plugin is published as a non-development channel. If not, fallback is X-a (user keeps the flag).
4. **systemd user service on non-systemd Linux / macOS**. macOS uses launchd. Initial release ships Linux/systemd only; macOS via `launchd` plist is a follow-up.

## 10. Glossary

- **X-b**: session the user starts manually in a terminal (`claude ...`). Auto-attaches to bridge via plugin shim.
- **Y-b**: session the daemon spawns in a tmux window in response to a top-level Feishu message.
- **L2**: thread lifecycle policy where inactive threads can be revived by new replies (vs. L1 one-shot, L3 mixed).
- **D-b**: daemon lifecycle managed by systemd user service (vs. D-a manual, D-c lazy auto-spawn, D-d mixed).
- **hub chat**: chat where X-b session threads live when there's no triggering message to root on. Stored explicitly as `access.json.hubChatId`; auto-populated on first pair.
- **thread_id**: Feishu native thread identifier, generated when a message is replied to with `reply_in_thread=true`. Routing key in this design.
- **session_id**: ULID allocated by the daemon, used internally to bind shim connections to threads across restarts.
