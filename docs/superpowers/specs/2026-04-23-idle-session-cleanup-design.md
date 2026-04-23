# Idle feishu-spawn session cleanup

**Status**: approved, pending implementation plan
**Owner**: xiaolong.835
**Date**: 2026-04-23

## Problem

Every new topic in the Feishu group spawns a fresh claude in its own tmux
window. There is currently no automatic teardown:

- `tmux kill-window` is never called from the daemon.
- `markInactive` only flips `threads.json` state when a shim disconnects; it
  does not kill the underlying claude process.
- `pruneInactive` only removes rows from `threads.json` at daemon boot and
  never touches live processes.

On the production host today this has produced **37 live claude processes**
totalling ~17 GB RSS, under a **tmux session with 18 windows**, on a machine
with 64 GB RAM and **no swap**. Left unbounded, the next few weeks of usage
will OOM the box.

## Goal

Auto-reclaim the **runtime resources** (claude process + tmux window) of
feishu-spawn sessions that have been idle long enough to be safely assumed
abandoned, while preserving the **thread binding** in `threads.json` so a
future message in the same topic transparently resumes the conversation via
`claude --resume <uuid>`.

Non-goals:

- Terminal-bridged sessions (`origin=terminal`) — daemon does not own their
  lifecycle; these are interactive claudes the user launched from a shell.
- Persistent conversation state — the session jsonl under
  `~/.claude/projects/<slug>/` is never touched; resume replays it.

## Requirements

| # | Requirement |
|---|---|
| R1 | A feishu-spawn session is eligible for cleanup after **24 h** of no `last_message_at` update. |
| R2 | Cleanup runs on a timer: first sweep **10 min** after daemon start, then every **12 h**. |
| R3 | Scope is strictly `origin === "feishu"` and `status !== "closed"`. Terminal-bridged sessions are never killed. |
| R4 | On cleanup: post a notification in the thread → `tmux kill-window` → mark thread `inactive` (NOT `closed` — `closed` remains reserved for user-triggered archive). |
| R5 | When a new inbound arrives in a thread that was swept, the existing `resumeSession` path re-spawns a claude with `claude --resume <uuid>`; conversation context is preserved. |
| R6 | Single sweep kills at most **20** sessions (safety valve against mass-eviction storms). |
| R7 | A single env variable (`FEISHU_IDLE_KILL_DISABLE=1`) disables the feature entirely, leaving prior behavior untouched. |
| R8 | Notification failures must not block kill; kill failures must not block state update. |

## Design

### Trigger & policy

- A `setTimeout`-chained sweep inside the daemon (NOT `setInterval`, so the
  next run can't overlap a slow one). Initial delay **10 min** after
  `Daemon.start()` — long enough for `bun sync` / `systemctl restart`
  reconnect storms to settle so we don't misread "nobody reconnected in
  time" as "everyone is idle". Subsequent delay **12 h**.
- Each tick:
  1. Load the current `threads.json` (the daemon already keeps it in
     memory; read from `this.threads`).
  2. Select all `ThreadRecord` where `origin === "feishu"`,
     `status !== "closed"`, and `now - last_message_at > 24h`.
  3. Sort ascending by `last_message_at` (oldest first) and take the first
     **20**. The sort + cap guarantee chronological fairness under backlog:
     the very oldest sessions always make it into each sweep.
  4. For each selected record, in this order:
     1. Post notification: `feishuApi.sendInThread({root_message_id,
        text: hibernateText, format: "markdown", seed_thread: false})`.
        Wrap in `.catch()` — log only.
     2. **Remove from `DaemonState`** before killing the window. This
        closes the routing window during which a concurrent inbound could
        still try to `send-keys` into a pane that is about to die (see
        Race notes).
     3. `tmux kill-window -t <tmuxSession>:<windowName>` with
        `windowName = rec.tmux_window_name ?? "fb:" + rec.session_id.slice(0, 8)`.
        Wrap in `.catch()` — log only.
     4. `rec.status = "inactive"` in the in-memory store.
  5. One `saveThreads(...)` at the end of the tick (batched write).

### Tunables (env)

| Var | Default | Meaning |
|---|---|---|
| `FEISHU_IDLE_KILL_HOURS` | `24` | Idleness threshold (ms computed once per sweep). |
| `FEISHU_IDLE_SWEEP_HOURS` | `12` | Delay between sweeps. |
| `FEISHU_IDLE_SWEEP_MAX` | `20` | Max sessions processed per sweep. |
| `FEISHU_IDLE_KILL_DISABLE` | *(unset)* | `"1"` disables the scheduler entirely. |

Parse errors (non-numeric, negative) fall back silently to the default.

### Schema change

Extend `ThreadRecord` with an optional field:

```ts
tmux_window_name?: string
```

Populated at three sites:

1. `handleRegister`, spawnIntent with `preExistingThreadId` — `msg.tmux_window_name`
   is already available (shim reports it).
2. `handleReply`, `!bound && !pending && feishuRoot` branch — read from
   `this.state.get(entry.session_id)?.tmux_window_name` before the
   `upsertThread` that seeds the thread.
3. `handleReply`, `!bound && pending` branch — same as (2). (Terminal path,
   but keeping the schema symmetric avoids edge cases when a terminal
   session somehow gets swept — which it never will under R3, but the
   field is harmless to carry.)

Legacy records: no field → sweep falls back to `"fb:" + session_id.slice(0, 8)`.
`tmux kill-window` on a nonexistent window returns non-zero; log and move on.

### Code structure

New file `src/idle-sweep.ts`:

```ts
export function selectIdleFeishuThreads(
  store: ThreadStore, now: number, idleMs: number, max: number,
): Array<ThreadRecord & { thread_id: string }>

export function sweepIntervalMs(env: NodeJS.ProcessEnv): number
// Returns 0 when FEISHU_IDLE_KILL_DISABLE=1; caller treats 0 as "do not schedule".

export async function runIdleSweep(deps: {
  threads: ThreadStore
  saveThreads: (s: ThreadStore) => void
  feishuApi: FeishuApi | null
  killTmuxWindow: (session: string, windowName: string) => Promise<void>
  daemonState: DaemonState
  tmuxSession: string
  now: number
  idleMs: number
  max: number
  log: (msg: string) => void
}): Promise<{ killed: string[]; skipped: string[] }>
```

Daemon wiring (inside `Daemon.start()`, after `wsStart`):

```ts
const sweepMs = sweepIntervalMs(process.env)
if (sweepMs > 0) {
  setTimeout(() => d.scheduleIdleSweep(sweepMs), 10 * 60_000)
}
```

`Daemon.scheduleIdleSweep(delayMs)` is a private method: one-shot
`setTimeout` → call `runIdleSweep` → recurse with the same delay. Async
re-entrance is thus impossible.

### State machine (delta)

```
 [active] ──(shim disconnect)──> [inactive] ──(new inbound)──> resumeSession ──> [active]
    │                                ▲
    │                                │
    └──(sweep hits 24 h idle)────────┘   ⟵ new trigger
```

No new state introduced. Sweep just adds a trigger for the existing
`active → inactive` edge. The existing `resumeSession` path already handles
`inactive` → live `claude --resume`.

### Race / ordering notes

- Sweep marks `inactive` → claude's shim is about to die. If an MCP
  outbound call from that claude lands in the narrow window before SIGHUP
  propagates, `handleReply` still sends (`inactive` status does not gate
  outbound replies — it only affects sweep/resume selection). Harmless.
- A new **inbound** arriving concurrently with the sweep of the same
  thread, walking through `deliverFeishuEvent`:
  - Step 4.1 (notify) in flight → `state.get` still returns the live
    entry → routes through tmux `send-keys` normally.
  - Between step 4.2 (state.remove) and step 4.3 (kill-window):
    `state.get(rec.session_id)` returns undefined → falls through to
    `resumeSession`. A fresh `claude --resume` is kicked off in a new
    window; the dying window closes shortly after. Safe (no lost
    message); momentary overlap of two claudes on the same
    `session_id` while the old one is dying is benign — only the new
    one has a registered shim, and `DaemonState.register` for the new
    shim sees no `prev` (we removed it in 4.2).
  - After step 4.4 (state → inactive, in memory): same as above —
    `state.get` undefined → `resumeSession`. On disk the flip lands
    only at end-of-tick; this is fine because routing only consults
    memory.

## Testing

### Unit — `tests/idle-sweep.test.ts`

- `selectIdleFeishuThreads`: hits, terminal-origin skip, closed skip,
  unmatured skip (boundary: exactly 24 h excluded), cap + oldest-first
  ordering, legacy records with no `tmux_window_name` still returned.
- `runIdleSweep`: happy path ordering (notify → kill → state flip → save);
  notify failure doesn't block kill; kill failure doesn't block state;
  legacy fallback window name.
- `sweepIntervalMs`: default, override, malformed input (fallback),
  `FEISHU_IDLE_KILL_DISABLE=1` returns 0.

### Daemon wiring — extend `tests/daemon-routing.test.ts`

- Expose a test-only `daemon.runIdleSweepOnce(now)`. Assert: a 25 h-old
  feishu thread → notification sent, tmux kill-window called with the
  correct target, `threads.json` flipped to `inactive`. A 25 h-old
  **terminal**-origin thread is untouched.
- Resume regression: after sweeping a thread, deliver an inbound for the
  same `thread_id` → `resumeSession` path fires (reuses existing coverage).

### Integration — `tests/integration/idle-sweep.test.ts`

Real `threads.json` in a temp `FEISHU_STATE_DIR`, real daemon instance
with `spawnOverride` + fake feishu API. Seed one 25 h-old feishu record,
one fresh feishu record, one old terminal record. Call
`runIdleSweepOnce`. Read `threads.json` from disk and assert only the
target row flipped; verify the mocked `tmux` command received
`kill-window` with the right window name (including the legacy-fallback
path with a record lacking `tmux_window_name`).

### Out of scope for automated tests

- Real tmux / real Feishu — covered by `docs/self-validation.md`.
- Actual timer fire — covered by testing `sweepIntervalMs` and invoking
  `runIdleSweepOnce` directly.

## Rollout

1. Land code + tests on `feat/multi-session-bridge`.
2. `bun sync` to production plugin cache; `systemctl --user restart claude-feishu`.
3. First sweep 10 min after restart; observe logs for `daemon: idle sweep
   processed N session(s)`.
4. For the **existing backlog** (currently ~37 live claudes from weeks of
   usage): let the 12 h sweep rhythm drain them over the next day or two.
   The safety cap of 20 ensures each sweep only evicts a bounded batch;
   after two or three sweeps the host memory should be in the 2–3 GB range
   for this plugin's processes.

## Alternatives considered

- **LRU with hard cap on concurrent sessions**: simpler steady-state, but
  means a sudden burst of new topics evicts older ones that users might
  still care about. Idle-based is fairer.
- **Kill on shim disconnect**: dangerous — shim can disconnect during a
  `bun sync` restart while claude is mid-turn; we'd lose in-flight work.
  Decoupling via the 24 h idle timer avoids this entirely.
- **SIGTERM-then-SIGKILL the claude process directly**: no benefit for a
  headless `--dangerously-skip-permissions` claude with no pending user
  flushes; `tmux kill-window` hands the same signal tree down via SIGHUP.
  One fewer moving part.
