# Feishu Bootstrap Prompt Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read SOUL.md / USER.md / FEISHU.md / AGENTS.md from `~/.claude/channels/feishu/workspace/` and prepend their contents as a header on the initial prompt of every freshly-spawned Feishu session, leaving resume / X-b / thread-forward paths untouched.

**Architecture:** New pure module `src/bootstrap.ts` exposes `loadBootstrap(stateDir): string`. It walks four fixed filenames in order, applies per-file (32 KB) and aggregate (64 KB) caps, and returns either an empty string or a markdown header block ending with `---\n\n# User Message\n\n`. `daemon.ts:spawnFeishu()` calls it once between `extractTextAndAttachment(...)` and the existing `prompt`-consuming sites, so both `buildSpawnCommand` and `sendKeysIntoPane` receive the prefixed prompt. No other call sites change.

**Tech Stack:** Bun runtime, TypeScript, `bun test` (alias for `bun:test`). Source under `src/`, tests under `tests/`. Existing patterns: `src/access.ts` for state-dir-rooted file IO; `tests/spawn.test.ts` and `tests/inbound.test.ts` for the unit-test style; `cfg.spawnOverride` hook in `src/daemon.ts` for integration tests that observe spawn arguments.

**Working directory:** `~/go/src/github.com/Long-Feeds/claude-feishu-plugin` on branch `feat/bootstrap-prompt-injection`.

**Spec reference:** `docs/superpowers/specs/2026-04-27-feishu-bootstrap-prompt-design.md`.

---

### File structure

| File | Status | Responsibility |
|---|---|---|
| `src/bootstrap.ts` | create | Pure `loadBootstrap(stateDir)` — read four fixed files, apply caps, build header. No side effects beyond stderr warnings. |
| `tests/bootstrap.test.ts` | create | Unit tests for `loadBootstrap` covering empty / partial / full / cap / error paths. |
| `src/daemon.ts` | modify | One call site in `spawnFeishu()` — compute `bootstrap` once, prepend to `prompt`. ~5 lines. |
| `tests/daemon-bootstrap.test.ts` | create | Integration test using `cfg.spawnOverride` to assert the header reaches `cmd.env.FEISHU_INITIAL_PROMPT` for `kind=feishu`, and that resume path is unaffected. |
| `README.md` | modify | Add a short "Bootstrap files" subsection under Configuration, documenting the four filenames, their semantics, and the `workspace/` path. |

---

### Task 1: Scaffold `src/bootstrap.ts` with empty-stateDir test

**Files:**
- Create: `src/bootstrap.ts`
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 1.1: Write the failing test for the empty case**

Create `tests/bootstrap.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadBootstrap } from "../src/bootstrap"

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "feishu-bootstrap-test-"))
}

test("returns empty string when workspace dir is missing", () => {
  const stateDir = tempStateDir()
  try {
    expect(loadBootstrap(stateDir)).toBe("")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("returns empty string when workspace dir exists but is empty", () => {
  const stateDir = tempStateDir()
  try {
    const fs = require("fs") as typeof import("fs")
    fs.mkdirSync(join(stateDir, "workspace"))
    expect(loadBootstrap(stateDir)).toBe("")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `cd ~/go/src/github.com/Long-Feeds/claude-feishu-plugin && bun test tests/bootstrap.test.ts`
Expected: FAIL with "Cannot find module '../src/bootstrap'" (or similar resolution error).

- [ ] **Step 1.3: Create the minimal implementation**

Create `src/bootstrap.ts`:

```ts
import { readFileSync } from "fs"
import { join } from "path"

const FILES = ["SOUL.md", "USER.md", "FEISHU.md", "AGENTS.md"] as const

export function loadBootstrap(stateDir: string): string {
  const dir = join(stateDir, "workspace")
  const sections: string[] = []
  for (const name of FILES) {
    let body: string
    try {
      body = readFileSync(join(dir, name), "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        process.stderr.write(`bootstrap: failed to read ${name}: ${(e as Error).message}\n`)
      }
      continue
    }
    const trimmed = body.trim()
    if (!trimmed) continue
    sections.push(`## ${name.replace(/\.md$/, "")}\n${trimmed}`)
  }
  if (!sections.length) return ""
  return `# Feishu Channel Bootstrap\n\n${sections.join("\n\n")}\n\n---\n\n# User Message\n\n`
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 2 tests pass.

- [ ] **Step 1.5: Commit**

```bash
cd ~/go/src/github.com/Long-Feeds/claude-feishu-plugin
git add src/bootstrap.ts tests/bootstrap.test.ts
git commit -m "feat: scaffold loadBootstrap module with empty-state tests"
```

---

### Task 2: Single-file happy path (SOUL.md only)

**Files:**
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 2.1: Add a failing test for one populated file**

Append to `tests/bootstrap.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "fs"

test("emits a single section when only SOUL.md is present", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "SOUL.md"), "you are a lobster")
    const out = loadBootstrap(stateDir)
    expect(out.startsWith("# Feishu Channel Bootstrap\n\n")).toBe(true)
    expect(out).toContain("## SOUL\nyou are a lobster")
    expect(out).not.toContain("## USER")
    expect(out).not.toContain("## FEISHU")
    expect(out).not.toContain("## AGENTS")
    expect(out.endsWith("---\n\n# User Message\n\n")).toBe(true)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2.2: Run tests, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 3 tests pass (the new test should pass against the Task 1 implementation already — this test is a regression guard for the happy path).

- [ ] **Step 2.3: Commit**

```bash
git add tests/bootstrap.test.ts
git commit -m "test: bootstrap single-file happy path"
```

---

### Task 3: All four files in fixed order

**Files:**
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 3.1: Add the failing test for full set**

Append to `tests/bootstrap.test.ts`:

```ts
test("emits all four sections in fixed order: SOUL, USER, FEISHU, AGENTS", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "SOUL.md"), "soul body")
    writeFileSync(join(ws, "USER.md"), "user body")
    writeFileSync(join(ws, "FEISHU.md"), "feishu body")
    writeFileSync(join(ws, "AGENTS.md"), "agents body")
    const out = loadBootstrap(stateDir)
    const soul = out.indexOf("## SOUL")
    const user = out.indexOf("## USER")
    const feishu = out.indexOf("## FEISHU")
    const agents = out.indexOf("## AGENTS")
    expect(soul).toBeGreaterThan(-1)
    expect(soul).toBeLessThan(user)
    expect(user).toBeLessThan(feishu)
    expect(feishu).toBeLessThan(agents)
    expect(out).toContain("## SOUL\nsoul body")
    expect(out).toContain("## USER\nuser body")
    expect(out).toContain("## FEISHU\nfeishu body")
    expect(out).toContain("## AGENTS\nagents body")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3.2: Run tests, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add tests/bootstrap.test.ts
git commit -m "test: bootstrap fixed-order full set"
```

---

### Task 4: Subset preservation — order locked, missing skipped

**Files:**
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 4.1: Add the failing test for partial set**

Append to `tests/bootstrap.test.ts`:

```ts
test("preserves fixed order when only USER.md and AGENTS.md are present", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "USER.md"), "user")
    writeFileSync(join(ws, "AGENTS.md"), "agents")
    const out = loadBootstrap(stateDir)
    const user = out.indexOf("## USER")
    const agents = out.indexOf("## AGENTS")
    expect(user).toBeGreaterThan(-1)
    expect(agents).toBeGreaterThan(-1)
    expect(user).toBeLessThan(agents)
    expect(out).not.toContain("## SOUL")
    expect(out).not.toContain("## FEISHU")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 4.2: Run tests, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 5 tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add tests/bootstrap.test.ts
git commit -m "test: bootstrap subset preserves fixed order"
```

---

### Task 5: Whitespace-only file is skipped

**Files:**
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 5.1: Add the failing test for whitespace-only file**

Append to `tests/bootstrap.test.ts`:

```ts
test("skips whitespace-only file as if absent", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    writeFileSync(join(ws, "SOUL.md"), "   \n\n\t  \n")
    writeFileSync(join(ws, "USER.md"), "real user content")
    const out = loadBootstrap(stateDir)
    expect(out).not.toContain("## SOUL")
    expect(out).toContain("## USER\nreal user content")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 5.2: Run tests, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 6 tests pass (the `if (!trimmed) continue` line in Task 1 already covers this; test is a guard).

- [ ] **Step 5.3: Commit**

```bash
git add tests/bootstrap.test.ts
git commit -m "test: bootstrap skips whitespace-only files"
```

---

### Task 6: Read errors other than ENOENT log + skip

**Files:**
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 6.1: Add the failing test for permission error**

Append to `tests/bootstrap.test.ts`:

```ts
import { chmodSync } from "fs"

test("logs and skips a file that cannot be read (EACCES), keeps loading the rest", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    const soulPath = join(ws, "SOUL.md")
    writeFileSync(soulPath, "soul")
    chmodSync(soulPath, 0o000) // make unreadable
    writeFileSync(join(ws, "USER.md"), "user")

    // Capture stderr writes for assertion.
    const orig = process.stderr.write.bind(process.stderr)
    const logs: string[] = []
    ;(process.stderr as any).write = (chunk: any) => {
      logs.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }
    let out = ""
    try {
      out = loadBootstrap(stateDir)
    } finally {
      ;(process.stderr as any).write = orig
      // Restore mode so cleanup can rm the file.
      chmodSync(soulPath, 0o600)
    }
    expect(out).toContain("## USER\nuser")
    expect(out).not.toContain("## SOUL")
    expect(logs.join("")).toMatch(/bootstrap: failed to read SOUL\.md/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 6.2: Run tests, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: 7 tests pass. The Task 1 implementation already handles non-ENOENT errors by logging and continuing. If the test runs as root, EACCES won't fire and the test should be skipped — for a typical user environment it works. If you find yourself running tests as root, mark this test `.skip`.

- [ ] **Step 6.3: Commit**

```bash
git add tests/bootstrap.test.ts
git commit -m "test: bootstrap handles unreadable file gracefully"
```

---

### Task 7: Per-file 32 KB cap with truncation

**Files:**
- Modify: `src/bootstrap.ts`
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 7.1: Write the failing test**

Append to `tests/bootstrap.test.ts`:

```ts
test("truncates a single file that exceeds the 32 KB per-file cap", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    const big = "A".repeat(40 * 1024) // 40 KB
    writeFileSync(join(ws, "SOUL.md"), big)

    const orig = process.stderr.write.bind(process.stderr)
    const logs: string[] = []
    ;(process.stderr as any).write = (chunk: any) => {
      logs.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }
    let out = ""
    try {
      out = loadBootstrap(stateDir)
    } finally {
      ;(process.stderr as any).write = orig
    }

    expect(out).toContain("## SOUL\n")
    // Section body must be no longer than 32 KB (header excluded).
    const soulIdx = out.indexOf("## SOUL\n") + "## SOUL\n".length
    const nextSection = out.indexOf("\n\n##", soulIdx)
    const tail = out.indexOf("\n\n---\n\n# User Message", soulIdx)
    const end = nextSection === -1 ? tail : Math.min(nextSection, tail)
    const body = out.slice(soulIdx, end)
    expect(body.length).toBeLessThanOrEqual(32 * 1024)
    expect(logs.join("")).toMatch(/bootstrap: SOUL\.md exceeds 32KB cap/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 7.2: Run, confirm failure**

Run: `bun test tests/bootstrap.test.ts -t "32 KB"`
Expected: FAIL — body is 40 KB, no warning emitted.

- [ ] **Step 7.3: Add per-file cap to `src/bootstrap.ts`**

Replace `src/bootstrap.ts` with:

```ts
import { readFileSync } from "fs"
import { join } from "path"

const FILES = ["SOUL.md", "USER.md", "FEISHU.md", "AGENTS.md"] as const
const PER_FILE_CAP = 32 * 1024

export function loadBootstrap(stateDir: string): string {
  const dir = join(stateDir, "workspace")
  const sections: string[] = []
  for (const name of FILES) {
    let body: string
    try {
      body = readFileSync(join(dir, name), "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        process.stderr.write(`bootstrap: failed to read ${name}: ${(e as Error).message}\n`)
      }
      continue
    }
    if (Buffer.byteLength(body, "utf8") > PER_FILE_CAP) {
      process.stderr.write(`bootstrap: ${name} exceeds 32KB cap, truncating\n`)
      // Truncate by byte length on character boundaries.
      const buf = Buffer.from(body, "utf8").subarray(0, PER_FILE_CAP)
      body = buf.toString("utf8")
    }
    const trimmed = body.trim()
    if (!trimmed) continue
    sections.push(`## ${name.replace(/\.md$/, "")}\n${trimmed}`)
  }
  if (!sections.length) return ""
  return `# Feishu Channel Bootstrap\n\n${sections.join("\n\n")}\n\n---\n\n# User Message\n\n`
}
```

- [ ] **Step 7.4: Run, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/bootstrap.ts tests/bootstrap.test.ts
git commit -m "feat: bootstrap per-file 32KB cap with truncation warning"
```

---

### Task 8: Aggregate 64 KB cap drops trailing sections

**Files:**
- Modify: `src/bootstrap.ts`
- Test: `tests/bootstrap.test.ts`

- [ ] **Step 8.1: Write the failing test**

Append to `tests/bootstrap.test.ts`:

```ts
test("drops trailing sections when aggregate exceeds 64 KB cap", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    // Each at 30 KB → all four = 120 KB joined, way over the 64 KB cap.
    const body = "X".repeat(30 * 1024)
    writeFileSync(join(ws, "SOUL.md"), body)
    writeFileSync(join(ws, "USER.md"), body)
    writeFileSync(join(ws, "FEISHU.md"), body)
    writeFileSync(join(ws, "AGENTS.md"), body)

    const orig = process.stderr.write.bind(process.stderr)
    const logs: string[] = []
    ;(process.stderr as any).write = (chunk: any) => {
      logs.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }
    let out = ""
    try {
      out = loadBootstrap(stateDir)
    } finally {
      ;(process.stderr as any).write = orig
    }

    // SOUL must survive (it's first), AGENTS must be dropped (it's last).
    expect(out).toContain("## SOUL")
    expect(out).not.toContain("## AGENTS")
    expect(logs.join("")).toMatch(/bootstrap: aggregate exceeds 64KB/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 8.2: Run, confirm failure**

Run: `bun test tests/bootstrap.test.ts -t "64 KB"`
Expected: FAIL — all four sections currently emitted regardless of total size.

- [ ] **Step 8.3: Add aggregate cap logic**

Replace the tail of `src/bootstrap.ts` (the part after the FILES loop) with:

```ts
  if (!sections.length) return ""

  const AGG_CAP = 64 * 1024
  const dropped: string[] = []
  while (sections.length > 1 && Buffer.byteLength(sections.join("\n\n"), "utf8") > AGG_CAP) {
    // Drop from the END of the fixed order.
    const popped = sections.pop()!
    const sectionName = popped.split("\n", 1)[0]!.replace(/^## /, "")
    dropped.push(sectionName)
  }
  if (dropped.length) {
    process.stderr.write(`bootstrap: aggregate exceeds 64KB cap, dropped sections: ${dropped.reverse().join(", ")}\n`)
  }

  return `# Feishu Channel Bootstrap\n\n${sections.join("\n\n")}\n\n---\n\n# User Message\n\n`
}
```

The full `bootstrap.ts` should now define `PER_FILE_CAP` and `AGG_CAP` as module constants and expose only `loadBootstrap`.

- [ ] **Step 8.4: Run, confirm pass**

Run: `bun test tests/bootstrap.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/bootstrap.ts tests/bootstrap.test.ts
git commit -m "feat: bootstrap aggregate 64KB cap drops trailing sections"
```

---

### Task 9: Wire `loadBootstrap` into `daemon.ts:spawnFeishu`

**Files:**
- Modify: `src/daemon.ts` (around lines 1108-1155)
- Create: `tests/daemon-bootstrap.test.ts`

- [ ] **Step 9.1: Write the failing integration test**

Create `tests/daemon-bootstrap.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Daemon } from "../src/daemon"

function makeFeishuEvent(text: string): any {
  return {
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_id: "om_test",
      chat_id: "oc_test",
      message_type: "text",
      content: JSON.stringify({ text }),
      chat_type: "p2p",
      create_time: String(Date.now()),
    },
  }
}

function decodeInitialPrompt(env: Record<string, string>): string {
  return Buffer.from(env.FEISHU_INITIAL_PROMPT!, "base64").toString("utf8")
}

test("spawnFeishu prepends bootstrap header when SOUL.md exists", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-daemon-bootstrap-"))
  try {
    mkdirSync(join(stateDir, "workspace"))
    writeFileSync(join(stateDir, "workspace", "SOUL.md"), "you reply in haiku")

    // Pre-pair the test sender so gate accepts the message.
    writeFileSync(join(stateDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["ou_test"],
      groups: {},
      pending: {},
      hubChatId: "oc_test",
    }))

    let captured: { argv: string[]; env: Record<string, string> } | null = null
    const daemon = new Daemon({
      stateDir,
      defaultCwd: stateDir, // use any existing dir; test never spawns claude
      tmuxSession: "test-tmux",
      spawnOverride: async (argv, env) => {
        captured = { argv, env }
        return 0
      },
      // Disable WS / IPC for this test — we only exercise spawnFeishu via the test API below.
    } as any)

    // Direct spawnFeishu invocation via private accessor for unit-style integration test.
    await (daemon as any).spawnFeishu(makeFeishuEvent("帮我写个排序"))

    expect(captured).not.toBeNull()
    const prompt = decodeInitialPrompt(captured!.env)
    expect(prompt.startsWith("# Feishu Channel Bootstrap")).toBe(true)
    expect(prompt).toContain("## SOUL\nyou reply in haiku")
    expect(prompt).toContain("---\n\n# User Message\n\n帮我写个排序")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("spawnFeishu emits user prompt verbatim when no bootstrap files exist", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-daemon-bootstrap-empty-"))
  try {
    writeFileSync(join(stateDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["ou_test"],
      groups: {},
      pending: {},
      hubChatId: "oc_test",
    }))

    let captured: { argv: string[]; env: Record<string, string> } | null = null
    const daemon = new Daemon({
      stateDir,
      defaultCwd: stateDir,
      tmuxSession: "test-tmux",
      spawnOverride: async (argv, env) => {
        captured = { argv, env }
        return 0
      },
    } as any)

    await (daemon as any).spawnFeishu(makeFeishuEvent("hello"))

    const prompt = decodeInitialPrompt(captured!.env)
    expect(prompt).toBe("hello")
    expect(prompt).not.toContain("# Feishu Channel Bootstrap")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

> **Note for the implementer:** if `Daemon`'s constructor requires options the snippet above doesn't pass (e.g. WebSocket configuration), look at `tests/daemon-routing.test.ts` for the canonical test scaffold and copy its `cfg` shape — keep `stateDir`, `spawnOverride`, and any WS-disabling flag it uses. Do not add new dependencies.

- [ ] **Step 9.2: Run, confirm failure**

Run: `bun test tests/daemon-bootstrap.test.ts`
Expected: FAIL — the bootstrap header is missing because `spawnFeishu` doesn't yet call `loadBootstrap`.

- [ ] **Step 9.3: Splice `loadBootstrap` into `spawnFeishu`**

Edit `src/daemon.ts`:

1. Add the import near the existing `import { buildSpawnCommand, ensureTmuxSession, tmuxNameSlug } from "./spawn"` line:

```ts
import { loadBootstrap } from "./bootstrap"
```

2. In `spawnFeishu()`, find the block that currently reads (around line 1119-1126):

```ts
    const { text: prompt, attachment } = extractTextAndAttachment(event)
    // Window name carries the prompt's first 5 chars ...
    const slug = tmuxNameSlug(prompt, 5)
    const rand = Math.random().toString(36).slice(2, 8)
    const windowName = slug ? `fb:${slug}-${rand}` : `fb:${rand}`
```

   Replace with:

```ts
    const { text: rawPrompt, attachment } = extractTextAndAttachment(event)
    // Window name carries the prompt's first 5 chars; use the user's text only,
    // not the bootstrap header, so window names stay scannable.
    const slug = tmuxNameSlug(rawPrompt, 5)
    const rand = Math.random().toString(36).slice(2, 8)
    const windowName = slug ? `fb:${slug}-${rand}` : `fb:${rand}`
    // Prepend channel-level bootstrap context (SOUL.md / USER.md / FEISHU.md /
    // AGENTS.md from <stateDir>/workspace/) once per fresh feishu spawn.
    // Empty when no bootstrap files exist — falls through to today's behaviour.
    const bootstrap = loadBootstrap(this.cfg.stateDir)
    const prompt = bootstrap + rawPrompt
```

3. Verify nothing else in the function references the old `prompt` variable from before this point — every downstream consumer (`pendingFeishuSpawns.set(...)`, `buildSpawnCommand({ initial_prompt: prompt, ... })`, `setTimeout(() => this.sendKeysIntoPane(windowName, prompt, inboundMeta), delay)`) should already use the variable named `prompt`. After this edit, that variable holds bootstrap + rawPrompt, which is what we want.

- [ ] **Step 9.4: Run integration tests, confirm pass**

Run: `bun test tests/daemon-bootstrap.test.ts`
Expected: 2 tests pass.

- [ ] **Step 9.5: Run the full suite to make sure nothing else regressed**

Run: `bun test`
Expected: all existing tests still pass plus the new ones. If `tests/daemon-routing.test.ts` or `tests/inbound.test.ts` fail, the most likely cause is they assert on the prompt content and need to either set `cfg.stateDir` to a tmpdir without `workspace/` or stub `loadBootstrap` — patch them to use a stateDir whose `workspace/` is empty.

- [ ] **Step 9.6: Commit**

```bash
git add src/daemon.ts tests/daemon-bootstrap.test.ts
git commit -m "feat: inject bootstrap prompt into Feishu Y-b spawns"
```

---

### Task 10: Verify `kind=resume` does NOT inject bootstrap

**Files:**
- Test: `tests/daemon-bootstrap.test.ts`

- [ ] **Step 10.1: Add the negative test**

Append to `tests/daemon-bootstrap.test.ts`:

```ts
test("L2 resume path does not inject bootstrap header", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-daemon-bootstrap-resume-"))
  try {
    mkdirSync(join(stateDir, "workspace"))
    writeFileSync(join(stateDir, "workspace", "SOUL.md"), "DO NOT LEAK")

    // threads.json with one inactive thread bound to a known cwd + uuid.
    writeFileSync(join(stateDir, "threads.json"), JSON.stringify({
      "omt_resume": {
        thread_id: "omt_resume",
        chat_id: "oc_test",
        cwd: stateDir,
        session_id: "sess_a",
        claude_session_uuid: "11111111-1111-1111-1111-111111111111",
        status: "inactive",
        origin: "feishu",
        last_message_at: Date.now(),
      },
    }))
    writeFileSync(join(stateDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["ou_test"],
      groups: {},
      pending: {},
      hubChatId: "oc_test",
    }))

    let captured: { env: Record<string, string> } | null = null
    const daemon = new Daemon({
      stateDir,
      defaultCwd: stateDir,
      tmuxSession: "test-tmux",
      spawnOverride: async (_argv, env) => {
        captured = { env }
        return 0
      },
    } as any)

    // Use the canonical resume entrypoint. If `tests/daemon-routing.test.ts`
    // exercises this via a public method or routed inbound, copy its pattern
    // here and target thread_id=omt_resume so the daemon takes the resume path.
    const event = {
      sender: { sender_id: { open_id: "ou_test" } },
      message: {
        message_id: "om_resume_reply",
        chat_id: "oc_test",
        message_type: "text",
        content: JSON.stringify({ text: "ping" }),
        root_id: "omt_resume",
        thread_id: "omt_resume",
        chat_type: "p2p",
        create_time: String(Date.now()),
      },
    }
    await (daemon as any).onInboundEvent(event) // or whatever the routing entrypoint is

    expect(captured).not.toBeNull()
    const prompt = Buffer.from(captured!.env.FEISHU_INITIAL_PROMPT!, "base64").toString("utf8")
    expect(prompt).not.toContain("# Feishu Channel Bootstrap")
    expect(prompt).not.toContain("DO NOT LEAK")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
```

> **Note for the implementer:** the entrypoint name (`onInboundEvent` above) is a placeholder. Open `tests/daemon-routing.test.ts` and use whichever method or message-injection helper that file uses to drive a thread-bound inbound through the daemon — that's the canonical routing surface for tests. Update the test above to match. The assertion (no bootstrap header in the resume prompt) does not depend on the entrypoint shape.

- [ ] **Step 10.2: Run, confirm pass**

Run: `bun test tests/daemon-bootstrap.test.ts`
Expected: 3 tests pass. The resume code path in `daemon.ts` calls `buildSpawnCommand({ kind: "resume", initial_prompt: prompt, ... })` with the inbound's plain text — it never calls `loadBootstrap`, so this should pass without any code change in `daemon.ts`. If it fails, `loadBootstrap` was accidentally wired into `spawnResume` too — back the wiring out so it lives only in `spawnFeishu`.

- [ ] **Step 10.3: Commit**

```bash
git add tests/daemon-bootstrap.test.ts
git commit -m "test: bootstrap is not injected on L2 resume path"
```

---

### Task 11: Sync to plugin cache and run the manual smoke

**Files:** none (operational step)

- [ ] **Step 11.1: Sync the local source into the plugin cache and restart the daemon**

The repo's `package.json` defines a `sync` script that does this:

```bash
cd ~/go/src/github.com/Long-Feeds/claude-feishu-plugin
bun run sync
```

This rsyncs `src/` and `hooks/` into `~/.claude/plugins/cache/claude-feishu/feishu/0.0.1/` and runs `systemctl --user restart claude-feishu`.

If the script's hard-coded second target path (`/data00/home/xiaolong.835/claude-feishu-plugin/`) does not exist on this host, expect a non-zero rsync exit for that step — verify the first target (the plugin cache) updated by listing it:

```bash
ls -la ~/.claude/plugins/cache/claude-feishu/feishu/0.0.1/src/bootstrap.ts
```

Expected: file exists with the new contents.

- [ ] **Step 11.2: Manual smoke**

```bash
mkdir -p ~/.claude/channels/feishu/workspace
printf 'Reply in Cantonese only.\n' > ~/.claude/channels/feishu/workspace/SOUL.md
```

Then DM the bot a plain Mandarin question (e.g. "今天天氣怎麼樣?"). Expect Claude's reply to switch to Cantonese.

Cleanup once verified:

```bash
rm ~/.claude/channels/feishu/workspace/SOUL.md
rmdir ~/.claude/channels/feishu/workspace 2>/dev/null || true
systemctl --user restart claude-feishu
```

- [ ] **Step 11.3: Capture the smoke result in a commit message**

If the smoke passes, no commit needed. If you found a real problem, fix it and commit; do not silently re-run.

---

### Task 12: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 12.1: Add a "Bootstrap files" subsection under Configuration**

Open `README.md` and find the `## Configuration` section (the env-variable table). After that table, insert:

```markdown
### Bootstrap files

The daemon prepends a small set of markdown files to the initial prompt
of every freshly-spawned Feishu session (Y-b spawns). Drop any of the
following into `~/.claude/channels/feishu/workspace/`; missing files
are silently skipped:

| File | Purpose |
|---|---|
| `SOUL.md` | Personality, tone, guardrails for Claude's replies |
| `USER.md` | Who the operator is — preferences, working style, role |
| `FEISHU.md` | Channel-specific behaviour: reply formatting, attachment handling, reaction etiquette |
| `AGENTS.md` | Optional: multi-agent / skill coordination notes |

Files are read in the fixed order above. Resume (L2) and terminal-launched
sessions do not load bootstrap — they continue with the resumed jsonl or
the user's normal `CLAUDE.md` discovery.

Per-file cap: 32 KB. Aggregate cap: 64 KB; over-cap files are truncated and
trailing sections are dropped with a stderr warning. Read failures other
than `ENOENT` are logged to the daemon journal and do not block the spawn.
```

- [ ] **Step 12.2: Commit**

```bash
git add README.md
git commit -m "docs: document bootstrap files for Feishu Y-b spawns"
```

---

### Task 13: Final sanity sweep

**Files:** none

- [ ] **Step 13.1: Re-run the full test suite from a clean state**

```bash
cd ~/go/src/github.com/Long-Feeds/claude-feishu-plugin
bun test
```

Expected: all tests green. If any pre-existing test relied on `prompt` being byte-equal to the user's inbound text and breaks because a prior test populated `~/.claude/channels/feishu/workspace/`, that test is using the real `~/.claude` instead of an isolated `stateDir` — fix it to use a `mkdtempSync` stateDir (the same pattern used in `tests/bootstrap.test.ts`).

- [ ] **Step 13.2: Verify git log**

```bash
git log --oneline feat/bootstrap-prompt-injection
```

Expected: a clean linear chain of small commits, one per task, plus the original spec commit `2bcc82e`.

- [ ] **Step 13.3: Open a draft PR (optional)**

If you want to land this upstream, push and open a PR:

```bash
git push -u origin feat/bootstrap-prompt-injection
gh pr create --draft --title "feat: bootstrap prompt injection for Feishu Y-b spawns" --body "$(cat docs/superpowers/specs/2026-04-27-feishu-bootstrap-prompt-design.md | head -40)"
```

Confirm with the user before pushing — push is a public action.

---

## Self-review (against spec)

| Spec requirement | Implemented in |
|---|---|
| R1 workspace path = `<stateDir>/workspace/` | Task 1, Task 7 |
| R2 four filenames in fixed order | Task 1 (`FILES` array), Tasks 2–4 |
| R3 missing / empty files silent skip | Tasks 4, 5 |
| R4 only `kind=feishu` injects | Task 9 wires only into `spawnFeishu`; Task 10 verifies resume |
| R5 injection before `buildSpawnCommand` and `sendKeysIntoPane` | Task 9 step 9.3 (single `prompt` variable upstream of both) |
| R6 tmux slug uses raw user prompt | Task 9 step 9.3 (slug uses `rawPrompt`) |
| R7 32 KB / 64 KB caps | Tasks 7, 8 |
| R8 read errors logged, spawn continues | Task 6 |
| R9 stable human-readable shape | Task 1 (header), Tasks 3–4 (separator) |

No spec gaps. No "TBD" or "implement later" left in the plan. Type names and module names (`loadBootstrap`, `bootstrap.ts`, `FILES`, `PER_FILE_CAP`, `AGG_CAP`) are consistent across tasks.
