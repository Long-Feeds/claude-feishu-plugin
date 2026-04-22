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

test("findClaudeSessionUuid reads sessionId from ~/.claude/sessions/<pid>.json", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "bun", cwd: "/plugin" },
    98:  { ppid: 97, comm: "claude", cwd: "/home/me/proj" },
    97:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const readSessionFile = (pid: number) => {
    if (pid === 98) return JSON.stringify({
      pid: 98, sessionId: "3d40b615-a368-4cbf-8c03-d42f166883e9",
      cwd: "/home/me/proj", version: "2.1.117",
    })
    return null
  }
  expect(findClaudeSessionUuid({ fs, startPid: 100, readSessionFile })).toBe("3d40b615-a368-4cbf-8c03-d42f166883e9")
})

test("findClaudeSessionUuid returns null when session file missing", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "claude", cwd: "/home/me/proj" },
    98:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const readSessionFile = (_pid: number) => null
  expect(findClaudeSessionUuid({ fs, startPid: 100, readSessionFile })).toBeNull()
})

test("findClaudeSessionUuid returns null on malformed session file", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "claude", cwd: "/proj" },
    99:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const readSessionFile = (_pid: number) => "not-json"
  expect(findClaudeSessionUuid({ fs, startPid: 100, readSessionFile })).toBeNull()
})

test("findClaudeSessionUuid rejects a sessionId that doesn't look like a UUID", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "claude", cwd: "/proj" },
    99:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  const readSessionFile = (_pid: number) => JSON.stringify({ sessionId: "too-short" })
  expect(findClaudeSessionUuid({ fs, startPid: 100, readSessionFile })).toBeNull()
})

test("findClaudeSessionUuid returns null when no claude ancestor", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 1, comm: "systemd", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100 })).toBeNull()
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
