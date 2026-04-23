import { test, expect, beforeEach } from "bun:test"
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadAccess, saveAccess, defaultAccess, setHubChatId } from "../src/access"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feishu-access-test-"))
})

test("loadAccess returns defaults when file missing", () => {
  const a = loadAccess(join(dir, "access.json"))
  expect(a).toEqual(defaultAccess())
})

test("saveAccess then loadAccess round-trips", () => {
  const file = join(dir, "access.json")
  const a = defaultAccess()
  a.allowFrom.push("ou_abc")
  a.hubChatId = "oc_123"
  saveAccess(file, a)
  const back = loadAccess(file)
  expect(back.allowFrom).toEqual(["ou_abc"])
  expect(back.hubChatId).toBe("oc_123")
})

test("corrupt access.json is moved aside and defaults returned", () => {
  const file = join(dir, "access.json")
  writeFileSync(file, "{not valid", "utf8")
  const a = loadAccess(file)
  expect(a).toEqual(defaultAccess())
})

test("setHubChatId persists", () => {
  const file = join(dir, "access.json")
  saveAccess(file, defaultAccess())
  setHubChatId(file, "oc_xyz")
  expect(loadAccess(file).hubChatId).toBe("oc_xyz")
})
