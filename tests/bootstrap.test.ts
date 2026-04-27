import { test, expect } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
    mkdirSync(join(stateDir, "workspace"))
    expect(loadBootstrap(stateDir)).toBe("")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

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

test("logs and skips a file that cannot be read (EACCES), keeps loading the rest", () => {
  const stateDir = tempStateDir()
  try {
    const ws = join(stateDir, "workspace")
    mkdirSync(ws)
    const soulPath = join(ws, "SOUL.md")
    writeFileSync(soulPath, "soul")
    chmodSync(soulPath, 0o000) // make unreadable
    writeFileSync(join(ws, "USER.md"), "user")

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
      chmodSync(soulPath, 0o600)
    }
    expect(out).toContain("## USER\nuser")
    expect(out).not.toContain("## SOUL")
    expect(logs.join("")).toMatch(/bootstrap: failed to read SOUL\.md/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

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
