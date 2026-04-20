import { test, expect } from "bun:test"
import { frame, NdjsonParser } from "../src/ipc"

test("frame adds trailing newline", () => {
  expect(frame({ op: "reply", text: "hi" })).toBe('{"op":"reply","text":"hi"}\n')
})

test("NdjsonParser emits complete lines only", () => {
  const p = new NdjsonParser()
  const events: unknown[] = []
  p.feed('{"a":1}\n{"b"', (msg) => events.push(msg))
  expect(events).toEqual([{ a: 1 }])
  p.feed(':2}\n', (msg) => events.push(msg))
  expect(events).toEqual([{ a: 1 }, { b: 2 }])
})

test("NdjsonParser skips malformed lines and keeps going", () => {
  const p = new NdjsonParser()
  const events: unknown[] = []
  p.feed('not-json\n{"ok":true}\n', (msg) => events.push(msg))
  expect(events).toEqual([{ ok: true }])
})
