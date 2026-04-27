import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
