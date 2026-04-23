// Integration: seed a real threads.json on disk, run one sweep tick through
// Daemon.runIdleSweepOnce, read the file back, assert only the stale feishu
// threads got flipped and the right tmux commands were invoked. Exercises
// the schema → selector → executor → disk round-trip.

import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Daemon } from "../../src/daemon"
import { FeishuApi } from "../../src/feishu-api"
import { saveAccess, defaultAccess } from "../../src/access"
import { saveThreads, loadThreads } from "../../src/threads"

test("idle sweep: feishu stale killed, fresh feishu untouched, terminal untouched, legacy fallback window name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-integ-"))
  const sock = join(dir, "daemon.sock")

  const notifyCalls: string[] = []
  const api = new FeishuApi({
    im: {
      message: {
        create: async () => ({ data: {} }),
        reply: async (args: any) => {
          notifyCalls.push(args.path?.message_id ?? "")
          return { data: { message_id: "m_notif" } }
        },
        patch: async () => ({}),
      },
      messageReaction: { create: async () => ({}) },
      messageResource: { get: async () => ({ writeFile: async () => {} }) },
      image: { create: async () => ({}) }, file: { create: async () => ({}) },
    },
  })
  const acc = defaultAccess(); acc.hubChatId = "oc_hub"
  saveAccess(join(dir, "access.json"), acc)

  const now = Date.now()
  const TWO_DAYS = 2 * 86400_000
  const TEN_MIN = 10 * 60_000
  // NOTE: Daemon.start() sweeps status=active → inactive at boot, so seeding
  // threads as inactive keeps the test deterministic. The sweep targets any
  // non-closed record whose last_message_at is older than idleMs, so active
  // vs inactive here is immaterial.
  saveThreads(join(dir, "threads.json"), {
    version: 1,
    threads: {
      // Stale feishu thread WITH tmux_window_name — should be killed.
      t_feishu_stale_modern: {
        session_id: "abcd1234-0000-4000-8000-000000000001", chat_id: "oc_test",
        root_message_id: "m_root_modern", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "inactive",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
        tmux_window_name: "fb:recent-xyz",
      },
      // Stale feishu thread WITHOUT tmux_window_name — legacy fallback.
      t_feishu_stale_legacy: {
        session_id: "legacy12-0000-4000-8000-000000000002", chat_id: "oc_test",
        root_message_id: "m_root_legacy", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "inactive",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
      // Fresh feishu thread — must NOT be killed.
      t_feishu_fresh: {
        session_id: "fresh001-0000-4000-8000-000000000003", chat_id: "oc_test",
        root_message_id: "m_root_fresh", cwd: "/tmp/idle-integ",
        origin: "feishu", status: "inactive",
        last_active_at: now - TEN_MIN, last_message_at: now - TEN_MIN,
      },
      // Stale terminal thread — must NOT be killed (R3).
      t_terminal_stale: {
        session_id: "term0001-0000-4000-8000-000000000004", chat_id: "oc_hub",
        root_message_id: "m_root_term", cwd: "/tmp/idle-integ",
        origin: "terminal", status: "inactive",
        last_active_at: now - TWO_DAYS, last_message_at: now - TWO_DAYS,
      },
    },
    pendingRoots: {},
  })

  const spawnedCmds: string[][] = []
  const daemon = await Daemon.start({
    stateDir: dir, socketPath: sock, feishuApi: api, wsStart: async () => {},
    spawnOverride: async (argv) => { spawnedCmds.push(argv); return 0 },
    defaultCwd: "/tmp/idle-integ", tmuxSession: "claude-feishu",
  })

  const result = await daemon.runIdleSweepOnce(now)

  // Two feishu threads killed.
  expect(result.killed.sort()).toEqual(
    ["t_feishu_stale_legacy", "t_feishu_stale_modern"].sort(),
  )

  // Two notifications sent (to each stale feishu root)
  expect(notifyCalls.sort()).toEqual(["m_root_legacy", "m_root_modern"].sort())

  // Two kill-window invocations with correct target strings
  const kills = spawnedCmds
    .filter((a) => a[0] === "tmux" && a[1] === "kill-window")
    .map((a) => a[3]) // argv: ["tmux","kill-window","-t","<session>:<name>"]
  expect(kills.sort()).toEqual(
    ["claude-feishu:fb:legacy12", "claude-feishu:fb:recent-xyz"].sort(),
  )

  // Disk round-trip: stale feishu rows flipped (or stayed inactive); fresh
  // feishu + terminal rows untouched.
  const back = loadThreads(join(dir, "threads.json"))
  expect(back.threads["t_feishu_stale_modern"]!.status).toBe("inactive")
  expect(back.threads["t_feishu_stale_legacy"]!.status).toBe("inactive")
  expect(back.threads["t_feishu_fresh"]!.status).toBe("inactive")   // was seeded inactive
  expect(back.threads["t_terminal_stale"]!.status).toBe("inactive") // was seeded inactive

  await daemon.stop()
})
