# Feishu bootstrap prompt injection

**Status**: approved (chat), pending written-spec review
**Owner**: xiaolong.835
**Date**: 2026-04-27

## Problem

Every Y-b spawn (top-level Feishu DM / group message → fresh `claude`
session) starts with zero global context. The user's first Feishu message
is the entire prompt, so every conversation has to re-establish persona,
operator background, channel-specific reply conventions, etc.

`CLAUDE.md` discovery in the spawn cwd already covers project-level
context, but it does not cover **channel-level** defaults that should
apply to every Feishu-spawned session regardless of cwd, and that should
*not* leak into terminal-launched `claude` sessions on the same host.

We want a [OpenClaw][1]-style bootstrap: a small, fixed set of markdown
files maintained by the user, automatically prepended to the first prompt
of every freshly-spawned Feishu session.

[1]: https://github.com/openclaw/openclaw

## Goal

Inject a user-maintained set of markdown bootstrap files as a header on
the **initial prompt** of every Y-b spawn, so that every freshly-spawned
Feishu session opens with consistent persona / operator / channel
context, while leaving terminal sessions and resumed sessions untouched.

Non-goals (v1):

- Per-chat / per-group overrides — global only.
- Template variable substitution (`{{user}}`, `{{date}}`, …) — plain
  markdown body, no interpolation.
- L2 thread revival (`kind=resume`) — context comes from the resumed
  jsonl, not bootstrap.
- X-b terminal sessions — those use Claude Code's native `CLAUDE.md`
  discovery, not the daemon.
- Hot-reload watcher — bootstrap is read fresh on every spawn, which is
  already effectively hot.

## Requirements

| #  | Requirement |
|----|-------------|
| R1 | Bootstrap files live under `~/.claude/channels/feishu/workspace/` (alongside `access.json` / `threads.json`). |
| R2 | Recognised filenames are exactly `SOUL.md`, `USER.md`, `FEISHU.md`, `AGENTS.md`. Read in that order. |
| R3 | Any missing or empty bootstrap file is silently skipped. If `workspace/` does not exist or all four files are missing, behaviour is identical to today (zero injection). |
| R4 | Injection happens only when `kind === "feishu"` (Y-b spawn). `kind === "resume"` (L2 revival) and X-b terminal sessions are never injected. |
| R5 | Injection happens before the user's prompt is handed to `buildSpawnCommand` and `sendKeysIntoPane`, so both the env-var copy and the tmux-typed copy carry the bootstrap header. |
| R6 | Injection must NOT contaminate the tmux window-name slug — the slug stays derived from the user's original message. |
| R7 | Per-file size cap **32 KB**; aggregate bootstrap cap **64 KB**. Over-cap files are truncated with a stderr warning; spawn proceeds. |
| R8 | Read errors other than `ENOENT` are logged to stderr and the offending file is skipped; spawn proceeds. |
| R9 | The composed prompt has a stable, human-readable shape so Claude can clearly tell bootstrap context apart from the inbound message. |

## Design

### Layout

```
~/.claude/channels/feishu/workspace/
├── SOUL.md      # personality / tone / guardrails
├── USER.md      # who the operator is, preferences, working style
├── FEISHU.md    # channel-specific behaviour: reply formatting, attachments, reaction etiquette
└── AGENTS.md    # optional: multi-agent / skill coordination notes
```

Reuses the existing state-dir root (`~/.claude/channels/feishu/`); no
new top-level directory. The directory itself, and any individual file,
is optional. Files are ordinary markdown; the daemon does not parse
front-matter, headings, or any structure inside them.

### Composition format

When at least one bootstrap file is present, the daemon prepends a
header to the user's prompt before any downstream consumer sees it:

```text
# Feishu Channel Bootstrap

## SOUL
<contents of SOUL.md>

## USER
<contents of USER.md>

## FEISHU
<contents of FEISHU.md>

## AGENTS
<contents of AGENTS.md>

---

# User Message

<original inbound text from the Feishu user>
```

- Each section header uses `## <FILENAME-without-.md>` so Claude can
  identify the source file.
- Missing files produce no section at all (no empty heading).
- Top-level `# Feishu Channel Bootstrap` and the `---\n# User Message`
  separator together signal to Claude that everything above the rule is
  pre-loaded channel context, and the part below is the actual task.
- When zero files are present, no header is emitted: the prompt is
  byte-identical to today's behaviour.

### Code structure

New module `src/bootstrap.ts`:

- Pure function `loadBootstrap(stateDir: string): string`.
- Walks the four filenames in fixed order, builds the section list,
  applies size caps, returns either the empty string or a header
  block ending with `\n\n---\n\n# User Message\n\n`.
- Takes `stateDir` as an argument (no `process.env` lookup) so it is
  trivially unit-testable against a tmpdir.

`daemon.ts:spawnFeishu()` change set:

```ts
const { text: rawPrompt, attachment } = extractTextAndAttachment(event)
const slug = tmuxNameSlug(rawPrompt, 5)            // unchanged: user text only
const rand = Math.random().toString(36).slice(2, 8)
const windowName = slug ? `fb:${slug}-${rand}` : `fb:${rand}`

const bootstrap = loadBootstrap(this.stateDir)     // new
const prompt = bootstrap + rawPrompt               // new

// pendingFeishuSpawns / buildSpawnCommand / sendKeysIntoPane all use `prompt`
// (existing variable), so no other call site changes.
```

`spawnResume()` and the X-b shim path remain untouched (R4).

### Size-cap policy

- Per-file cap: 32 KB. If a file exceeds it, the body is truncated to
  32 KB and a stderr warning identifies the file. The truncated body is
  still emitted (the user gets the prefix of their content, not zero).
- Aggregate cap: 64 KB on the joined section text (before the
  `# Feishu Channel Bootstrap` outer header). If the joined text
  exceeds it, sections are dropped from the **end** of the fixed order
  (i.e. `AGENTS` first, `FEISHU` next, …) until the total fits, with a
  stderr warning naming the dropped sections.
- Caps are constants in `bootstrap.ts`. Tunable via env vars is **not**
  in v1; if needed later it's a one-line change.

### Error handling

| Failure | Daemon behaviour |
|---------|------------------|
| `workspace/` does not exist | Treat as no bootstrap, spawn normally |
| Individual file is `ENOENT` | Skip silently, no log |
| File read error other than `ENOENT` (e.g. `EACCES`, `EIO`) | Log to stderr `bootstrap: failed to read <name>: <err>`, skip file, continue |
| File over per-file cap | Truncate, log warning, continue |
| Aggregate over cap | Drop trailing sections, log warning, continue |
| `loadBootstrap` itself throws (defensive) | Caught by `spawnFeishu`, treat as empty bootstrap, spawn proceeds |

The contract is "bootstrap injection is best-effort; no bootstrap
failure ever prevents a spawn from going through." Users can lose
bootstrap context but never lose the ability to talk to the bot.

### Customisation extensibility (v2 hooks, not in v1)

The v1 design intentionally leaves room for these without committing to
them:

- **Template variables** in any `.md` body (e.g. `{{user_name}}`,
  `{{chat_id}}`, `{{date}}`). Substitution would happen inside
  `loadBootstrap` after read, before joining.
- **Per-chat overrides** under `workspace/groups/<chat_id>/`. The
  override file would shadow or merge with its global sibling.
- **A `/feishu:bootstrap` skill** to scaffold, validate, and preview
  the four files, mirroring OpenClaw's wizard.
- **Selective L2 injection** via an env flag, for cases where revived
  sessions get a clean Claude context and would benefit from re-loading
  bootstrap.

None of these are blockers for v1; each can land as an additive change
that does not touch the v1 injection point.

## Testing

### Unit tests (`src/bootstrap.test.ts`)

- All four files present → header contains all four sections in fixed order.
- Subset present (e.g. only `SOUL.md` and `FEISHU.md`) → header skips
  the absent sections and preserves order of present ones.
- All files absent → returns empty string.
- `workspace/` directory absent → returns empty string, no error.
- File over per-file cap → truncated, stderr warning, content present.
- Aggregate over cap → trailing sections dropped, stderr warning.
- File with `EACCES` → skipped, stderr warning, other files still load.
- File with leading/trailing whitespace → trimmed before emit; if body is
  whitespace-only, treated as empty (skipped).

### Integration test (`src/daemon.test.ts`)

- Spawn a Feishu inbound through the daemon with a stubbed
  `spawnOverride`. Pre-populate `workspace/SOUL.md` with a known string.
  Assert that the prompt eventually fed into `sendKeysIntoPane` starts
  with `# Feishu Channel Bootstrap` and contains the SOUL content.
- Same setup but with `kind=resume` path — assert no bootstrap header.

### Manual smoke

1. `mkdir -p ~/.claude/channels/feishu/workspace`
2. `echo '全程使用粤语回复' > ~/.claude/channels/feishu/workspace/SOUL.md`
3. DM the bot a plain Mandarin question.
4. Expect Claude's reply to be in Cantonese.

## Open questions

None — all decisions captured above.

## References

- OpenClaw bootstrap files: <https://github.com/openclaw/openclaw>
- Existing spawn entry point: `src/daemon.ts:spawnFeishu` (≈ line 1108)
- Existing prompt-extraction: `src/inbound.ts:extractTextAndAttachment`
- State-dir root: `src/access.ts` (already places `access.json` under
  `~/.claude/channels/feishu/`)
