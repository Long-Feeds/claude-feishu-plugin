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
