// Integration test for the concurrent feishu-spawn UUID race.
//
// Before the fix, two claude processes starting in the same cwd seconds apart
// would both end up registering with the SAME session_id: the second shim's
// jsonl-probe picked the first claude's still-fresh jsonl (newest mtime
// within the freshness window) because its OWN claude hadn't written the
// session jsonl yet (claude only writes it after processing the first
// prompt, and daemon send-keys fires 5s after spawn). That shared session_id
// caused every group-initiated reply to land in the wrong topic.
//
// This test builds a real ~/.claude layout on disk and walks through the
// same sequence of jsonl/pid-json writes that happens during a live
// concurrent spawn, calling findClaudeSessionUuid() directly (the same
// function the shim invokes every 100ms during its probe). We stub only
// /proc access — everything under ~/.claude is on the real filesystem.

import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { findClaudeSessionUuid, type ProcFs } from "../../src/resolve-cwd"

function fakeFs(tree: Record<number, { ppid: number; comm: string; cwd: string }>): ProcFs {
  return {
    readStatus: (pid) => {
      const n = tree[pid]
      return n ? `Name:\tx\nPPid:\t${n.ppid}\n` : null
    },
    readCwd: (pid) => tree[pid]?.cwd ?? null,
    readComm: (pid) => tree[pid]?.comm ?? null,
  }
}

function writePidJson(claudeHome: string, pid: number, sessionId: string, cwd: string): void {
  mkdirSync(join(claudeHome, "sessions"), { recursive: true })
  writeFileSync(
    join(claudeHome, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() }),
  )
}

function writeJsonl(
  claudeHome: string,
  cwdSlug: string,
  sessionId: string,
  mtimeMs: number,
): string {
  const dir = join(claudeHome, "projects", cwdSlug)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${sessionId}.jsonl`)
  writeFileSync(p, `{"type":"permission-mode","sessionId":"${sessionId}"}\n`)
  const t = mtimeMs / 1000
  utimesSync(p, t, t)
  return p
}

test("concurrent feishu-spawn: each shim resolves to ITS OWN claude's session, not a sibling's", () => {
  // Two claudes started in the same cwd. claude-1 has been running a few
  // seconds — enough that it has processed its first prompt and its jsonl
  // is fresh. claude-2 just started; its jsonl has NOT been written yet
  // (first prompt not processed, daemon's send-keys still pending).
  //
  // The fix relies on each claude's ~/.claude/sessions/<pid>.json carrying
  // that claude's OWN sessionId. Shim reads ITS parent's pid-json and, as
  // soon as the matching jsonl exists, returns that uuid — never latches
  // onto a sibling's jsonl by mtime alone.

  const root = mkdtempSync(join(tmpdir(), "uuid-probe-race-"))
  const claudeHome = join(root, ".claude")

  // MY cwd. Same for both claudes — that's the whole point of the race.
  const cwd = "/home/me/proj"
  const slug = "-home-me-proj"

  // claude-1: pid 90001, sessionId AAAA, jsonl written 1s ago.
  const pid1 = 90001
  const uuid1 = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1"
  writePidJson(claudeHome, pid1, uuid1, cwd)
  const now = Date.now()
  writeJsonl(claudeHome, slug, uuid1, now - 1000)

  // claude-2: pid 90002, sessionId BBBB, jsonl NOT YET written (claude-2
  // is still in its 5s pre-prompt window).
  const pid2 = 90002
  const uuid2 = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2"
  writePidJson(claudeHome, pid2, uuid2, cwd)

  // Process trees for the two shims. Each shim's immediate parent is a
  // `bun` wrapper; the claude ancestor is one hop further up. Both trees
  // also include the sibling claude pid (with comm="claude") so the
  // "is this pid-json owner still alive?" liveness check used by the
  // claimed-ids filter agrees it's a live claude.
  const shim1Tree = fakeFs({
    1000: { ppid: 999, comm: "bun", cwd: "/plugin" },
    999:  { ppid: pid1, comm: "bun", cwd: "/plugin" },
    [pid1]: { ppid: 1, comm: "claude", cwd },
    [pid2]: { ppid: 1, comm: "claude", cwd },
  })
  const shim2Tree = fakeFs({
    2000: { ppid: 1999, comm: "bun", cwd: "/plugin" },
    1999: { ppid: pid2, comm: "bun", cwd: "/plugin" },
    [pid1]: { ppid: 1, comm: "claude", cwd },
    [pid2]: { ppid: 1, comm: "claude", cwd },
  })

  // Freshness wide enough that claude-1's jsonl is definitely in-window.
  const freshnessMs = 30_000

  // shim-1 probes: resolves to uuid1 via fast path (pid-json says uuid1,
  // jsonl uuid1 exists).
  expect(findClaudeSessionUuid({
    fs: shim1Tree, startPid: 1000, claudeHome, freshnessMs, now,
  })).toBe(uuid1)

  // shim-2 probes BEFORE its own jsonl is written. Under the old buggy
  // logic this would return uuid1 (claude-1's jsonl is newest + fresh).
  // Under the fix it returns null: fast path fails (uuid2.jsonl absent);
  // slow path filters out uuid1 because it's claimed by live pid1.
  expect(findClaudeSessionUuid({
    fs: shim2Tree, startPid: 2000, claudeHome, freshnessMs, now,
  })).toBeNull()

  // Now claude-2 processes its first prompt and writes its jsonl. shim-2
  // is still in its 100ms retry loop. Next probe should resolve to uuid2.
  const laterNow = now + 6_000
  writeJsonl(claudeHome, slug, uuid2, laterNow - 500)

  expect(findClaudeSessionUuid({
    fs: shim2Tree, startPid: 2000, claudeHome, freshnessMs, now: laterNow,
  })).toBe(uuid2)

  // And shim-1 keeps resolving to uuid1 — adding a second claude didn't
  // steal its identity.
  expect(findClaudeSessionUuid({
    fs: shim1Tree, startPid: 1000, claudeHome, freshnessMs, now: laterNow,
  })).toBe(uuid1)
})

test("claude --continue: pid-json uuid has no jsonl but resume picks the actually-written one", () => {
  // A terminal user runs `claude --continue`. claude writes a pid-json
  // with a FRESH sessionId Y, then resumes an existing jsonl named X.
  // Y.jsonl never exists; X.jsonl gets a fresh mtime as claude appends.
  // No other live claude claims X. Shim must return X.

  const root = mkdtempSync(join(tmpdir(), "uuid-probe-continue-"))
  const claudeHome = join(root, ".claude")
  const cwd = "/home/me/proj"
  const slug = "-home-me-proj"

  const pid = 70001
  const freshUuid = "99999999-9999-4999-b999-999999999999"
  const resumedUuid = "cccccccc-cccc-4ccc-cccc-cccccccccccc"
  writePidJson(claudeHome, pid, freshUuid, cwd)

  // Ancient jsonl (previous session — too old, filtered by freshness).
  const now = Date.now()
  writeJsonl(claudeHome, slug, "deadbeef-dead-4dea-bdea-deadbeef0000", now - 86_400_000)
  // The resumed jsonl, with a very fresh mtime.
  writeJsonl(claudeHome, slug, resumedUuid, now - 200)

  const tree = fakeFs({
    8000: { ppid: 7999, comm: "bun", cwd: "/plugin" },
    7999: { ppid: pid, comm: "bun", cwd: "/plugin" },
    [pid]: { ppid: 1, comm: "claude", cwd },
  })

  expect(findClaudeSessionUuid({
    fs: tree, startPid: 8000, claudeHome, freshnessMs: 30_000, now,
  })).toBe(resumedUuid)
})
