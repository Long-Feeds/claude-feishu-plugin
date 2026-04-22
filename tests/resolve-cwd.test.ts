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

test("findClaudeSessionUuid extracts uuid from claude's open jsonl fd", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "bun", cwd: "/plugin" },
    98:  {
      ppid: 97, comm: "claude", cwd: "/home/me/proj",
      fds: [
        "/dev/null",
        "/home/me/.claude/projects/-home-me-proj/3d40b615-a368-4cbf-8c03-d42f166883e9.jsonl",
        "/home/me/.claude/history.jsonl",  // not a session jsonl
      ],
    },
    97:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100 })).toBe("3d40b615-a368-4cbf-8c03-d42f166883e9")
})

test("findClaudeSessionUuid returns null when claude hasn't opened a session jsonl yet", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  { ppid: 98, comm: "claude", cwd: "/home/me/proj", fds: ["/dev/null"] },
    98:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100 })).toBeNull()
})

test("findClaudeSessionUuid handles a deleted jsonl fd marker", () => {
  const fs = fakeFs({
    100: { ppid: 99, comm: "bun", cwd: "/plugin" },
    99:  {
      ppid: 98, comm: "claude", cwd: "/home/me/proj",
      fds: ["/home/me/.claude/projects/-proj/abcdef123456-7890-1234-5678-901234567890.jsonl (deleted)"],
    },
    98:  { ppid: 1, comm: "bash", cwd: "/" },
  })
  expect(findClaudeSessionUuid({ fs, startPid: 100 })).toBe("abcdef123456-7890-1234-5678-901234567890")
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
