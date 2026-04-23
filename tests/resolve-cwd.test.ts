import { test, expect } from "bun:test"
import { resolveClaudeCwd, findClaudeSessionUuid, type ProcFs } from "../src/resolve-cwd"

type Node = { ppid: number; comm: string; cwd: string; fds?: string[] }
function fakeFs(tree: Record<number, Node>): ProcFs {
  return {
    readStatus: (pid) => {
      const n = tree[pid]
      return n ? `Name:\tx\nPPid:\t${n.ppid}\n` : null
    },
    readCwd: (pid) => tree[pid]?.cwd ?? null,
    readComm: (pid) => tree[pid]?.comm ?? null,
    listFds: (pid) => tree[pid]?.fds ?? [],
  }
}

test("resolveClaudeCwd returns the nearest claude ancestor's cwd", () => {
  // shim(100) → bun(99) → claude(98) → bash(97)
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "bun", cwd: "/plugin" },
    98:  { ppid: 97, comm: "claude", cwd: "/home/me/myproject" },
    97:  { ppid: 1,  comm: "bash", cwd: "/home/me" },
  })
  expect(resolveClaudeCwd({ fs, startPid: 100 })).toBe("/home/me/myproject")
})

test("resolveClaudeCwd picks the NEAREST claude when nested", () => {
  // If a user runs `claude` inside another `claude` session, we want the
  // inner one's cwd (the session actually hosting this shim), not the outer.
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "claude", cwd: "/inner/workdir" },
    98:  { ppid: 97, comm: "claude", cwd: "/outer/workdir" },
    97:  { ppid: 1,  comm: "bash", cwd: "/home/me" },
  })
  expect(resolveClaudeCwd({ fs, startPid: 100 })).toBe("/inner/workdir")
})

test("resolveClaudeCwd falls back to process.cwd when no claude ancestor", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 1,  comm: "systemd", cwd: "/" },
  })
  const res = resolveClaudeCwd({ fs, startPid: 100 })
  // shim started directly under systemd (e.g. bare bun test run) — no claude
  // ancestor to find, so we fall back to process.cwd().
  expect(res).toBe(process.cwd())
})

import { cwdToProjectSlug } from "../src/resolve-cwd"

test("cwdToProjectSlug matches claude's <cwd>→<slug> convention", () => {
  expect(cwdToProjectSlug("/home/me/proj")).toBe("-home-me-proj")
  expect(cwdToProjectSlug("/tmp/e2e-test-abc")).toBe("-tmp-e2e-test-abc")
})

test("findClaudeSessionUuid returns the UUID of the newest jsonl in project dir (recently touched)", () => {
  const now = 1_700_000_000_000
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "bun", cwd: "/plugin" },
    98:  { ppid: 97, comm: "claude", cwd: "/home/me/proj" },
    97:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const listJsonls = (dir: string) => {
    expect(dir).toBe("/fakehome/projects/-home-me-proj")
    return [
      { name: "11111111-1111-4111-a111-111111111111.jsonl", mtimeMs: now - 3_000_000 }, // hours old
      { name: "22222222-2222-4222-a222-222222222222.jsonl", mtimeMs: now - 500 },       // fresh
    ]
  }
  const uuid = findClaudeSessionUuid({
    fs, startPid: 100, claudeHome: "/fakehome", listJsonls, now,
  })
  expect(uuid).toBe("22222222-2222-4222-a222-222222222222")
})

test("findClaudeSessionUuid returns null when newest jsonl is stale (fresh claude, no writes yet)", () => {
  const now = 1_700_000_000_000
  const fs = fakeFs({
    100: { ppid: 99, comm: "claude", cwd: "/home/me/proj" },
    99:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const listJsonls = () => [
    { name: "11111111-1111-4111-a111-111111111111.jsonl", mtimeMs: now - 60_000 },
  ]
  expect(findClaudeSessionUuid({ fs, startPid: 100, claudeHome: "/h", listJsonls, now })).toBeNull()
})

test("findClaudeSessionUuid returns null when project dir is empty", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "claude", cwd: "/home/me/proj" },
    99:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100, claudeHome: "/h", listJsonls: () => [] })).toBeNull()
})

test("findClaudeSessionUuid returns null when no claude ancestor", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 1, comm: "systemd", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100, listJsonls: () => [] })).toBeNull()
})

test("findClaudeSessionUuid rejects a filename that isn't a UUID", () => {
  const now = 1_700_000_000_000
  const fs = fakeFs({
    100: { ppid: 99, comm: "claude", cwd: "/home/me/proj" },
    99:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const listJsonls = () => [{ name: "not-a-uuid.jsonl", mtimeMs: now }]
  expect(findClaudeSessionUuid({ fs, startPid: 100, claudeHome: "/h", listJsonls, now })).toBeNull()
})

test("findClaudeSessionUuid: pid-json fast path pins to MY jsonl even when a sibling claude's is newer", () => {
  // The regression: shim-2 probes while shim-1's claude is actively writing
  // its own jsonl. Without pid-json disambiguation, shim-2 picks shim-1's
  // jsonl by mtime. With the fix, shim-2's pid-json maps directly to its
  // own (fresher) jsonl; no race.
  const now = 1_700_000_000_000
  const fs = fakeFs({
    200: { ppid: 199, comm: "bun", cwd: "/plugin" },
    199: { ppid: 198, comm: "claude", cwd: "/home/me/proj" }, // MY claude, pid 199
    198: { ppid: 1,   comm: "bash", cwd: "/" },
  })
  const listJsonls = () => [
    // Sibling claude's jsonl (newer mtime — would win under old logic).
    { name: "99999999-9999-4999-a999-999999999999.jsonl", mtimeMs: now - 100 },
    // MY claude's jsonl (older mtime but matches MY pid-json sessionId).
    { name: "11111111-1111-4111-a111-111111111111.jsonl", mtimeMs: now - 2000 },
  ]
  const readPidSessionId = (pid: number) =>
    pid === 199 ? "11111111-1111-4111-a111-111111111111" : null
  const uuid = findClaudeSessionUuid({
    fs, startPid: 200, claudeHome: "/h", listJsonls, now, readPidSessionId,
  })
  expect(uuid).toBe("11111111-1111-4111-a111-111111111111")
})

test("findClaudeSessionUuid: when pid-json exists but its jsonl doesn't yet, return null (don't pick a sibling's)", () => {
  // Fresh feishu-spawn before the first prompt has been processed. MY
  // pid-json has my sessionId, but MY jsonl hasn't been created yet.
  // The sibling claude IS actively writing its jsonl. Under the old
  // code we'd latch onto the sibling's uuid; under the new code we
  // return null and retry until our own jsonl appears.
  const now = 1_700_000_000_000
  const fs = fakeFs({
    200: { ppid: 199, comm: "bun", cwd: "/plugin" },
    199: { ppid: 1,   comm: "claude", cwd: "/home/me/proj" },
  })
  const listJsonls = () => [
    // Only the sibling's jsonl exists right now.
    { name: "99999999-9999-4999-a999-999999999999.jsonl", mtimeMs: now - 100 },
  ]
  const readPidSessionId = (pid: number) =>
    pid === 199 ? "11111111-1111-4111-a111-111111111111" : null
  // Sibling claude (pid 300) has CLAIMED its sessionId in its pid-json.
  const listClaimedSessionIds = (_home: string, excludePid: number) => {
    expect(excludePid).toBe(199)
    return new Set(["99999999-9999-4999-a999-999999999999"])
  }
  expect(findClaudeSessionUuid({
    fs, startPid: 200, claudeHome: "/h", listJsonls, now,
    readPidSessionId, listClaimedSessionIds,
  })).toBeNull()
})

test("findClaudeSessionUuid: --continue falls through pid-json mismatch and picks the actively-written jsonl", () => {
  // `claude --continue`: pid-json has a fresh throwaway sessionId (Y),
  // but the jsonl being written is the resumed one (X). X.jsonl is
  // recent (claude just appended to it). No other live claude claims X.
  // Expect: return X.
  const now = 1_700_000_000_000
  const fs = fakeFs({
    200: { ppid: 199, comm: "bun", cwd: "/plugin" },
    199: { ppid: 1,   comm: "claude", cwd: "/home/me/proj" },
  })
  const listJsonls = () => [
    { name: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl", mtimeMs: now - 200 }, // X (resumed)
    { name: "deadbeef-dead-4dead-beef-deadbeefdead.jsonl", mtimeMs: now - 86_400_000 }, // ancient
  ]
  // pid-json's sessionId Y has no corresponding jsonl.
  const readPidSessionId = (pid: number) =>
    pid === 199 ? "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" : null
  const listClaimedSessionIds = () => new Set<string>() // no other live claudes
  expect(findClaudeSessionUuid({
    fs, startPid: 200, claudeHome: "/h", listJsonls, now,
    readPidSessionId, listClaimedSessionIds,
  })).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")
})

test("findClaudeSessionUuid: legacy (no pid-json) still returns newest-within-freshness", () => {
  // Back-compat: if the pid-json reader returns null (test didn't inject
  // one, or in prod the file hasn't been written yet AND no sibling
  // claimed anything), the resume-path still returns newest-in-window.
  const now = 1_700_000_000_000
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "bun", cwd: "/plugin" },
    98:  { ppid: 97, comm: "claude", cwd: "/home/me/proj" },
    97:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const listJsonls = () => [
    { name: "11111111-1111-4111-a111-111111111111.jsonl", mtimeMs: now - 3_000_000 },
    { name: "22222222-2222-4222-a222-222222222222.jsonl", mtimeMs: now - 500 },
  ]
  expect(findClaudeSessionUuid({
    fs, startPid: 100, claudeHome: "/h", listJsonls, now,
    readPidSessionId: () => null,
    listClaimedSessionIds: () => new Set<string>(),
  })).toBe("22222222-2222-4222-a222-222222222222")
})

test("resolveClaudeCwd respects maxDepth", () => {
  // Long chain with claude beyond the depth limit — should fall back.
  const tree: Record<number, { ppid: number; comm: string; cwd: string }> = {}
  for (let i = 100; i > 1; i--) {
    tree[i] = { ppid: i - 1, comm: i === 50 ? "claude" : "shell", cwd: `/p${i}` }
  }
  tree[1] = { ppid: 1, comm: "init", cwd: "/" }
  const fs = fakeFs(tree)
  expect(resolveClaudeCwd({ fs, startPid: 100, maxDepth: 3 })).toBe(process.cwd())
  expect(resolveClaudeCwd({ fs, startPid: 100, maxDepth: 60 })).toBe("/p50")
})
