import { spawn as nodeSpawn } from "child_process"

export type SpawnKind = "Y-b" | "resume"

export type SpawnArgs = {
  session_id: string
  cwd: string
  initial_prompt: string
  tmux_session: string
  kind: SpawnKind
  claude_session_uuid?: string
  window_name?: string
  spawn_cmd?: string
}

export type SpawnCommand = {
  argv: string[]
  env: Record<string, string>
}

export function buildSpawnCommand(args: SpawnArgs): SpawnCommand {
  const env: Record<string, string> = {
    FEISHU_SESSION_ID: args.session_id,
    FEISHU_INITIAL_PROMPT: Buffer.from(args.initial_prompt, "utf8").toString("base64"),
  }
  // Forward PATH so bash -c inside the tmux window can find `claude` and `bun`
  // (tmux new-window doesn't reliably carry the caller's PATH).
  if (process.env.PATH) env.PATH = process.env.PATH
  // Y-b and resume sessions are non-interactive — the "user" here is a Feishu
  // sender, not someone at the terminal. Skip permission prompts so reply /
  // react / edit_message / download_attachment calls don't block waiting for
  // a human at the tmux pane. The feishu plugin's channel notifications (via
  // shim) are the trust boundary; the user authorized the bot when they
  // installed the plugin + configured the Feishu app credentials.
  const claudeFlags = "--dangerously-skip-permissions"
  const claudeInvocation = args.kind === "resume" && args.claude_session_uuid
    ? `claude ${claudeFlags} --resume "${args.claude_session_uuid}" || (echo "[resume-fail:$?]"; sleep 30)`
    : `claude ${claudeFlags}`
  if (args.kind === "resume" && args.claude_session_uuid) {
    env.FEISHU_RESUME_UUID = args.claude_session_uuid
  }
  const windowName = args.window_name ?? `fb:${args.session_id.slice(0, 8)}`
  const tmuxBin = args.spawn_cmd ?? "tmux"

  const argv = [
    tmuxBin,
    "new-window",
    "-t", args.tmux_session,
    "-n", windowName,
    "-c", args.cwd,
    "bash",
    "-c",
    buildBashLauncher(env, claudeInvocation),
  ]
  return { argv, env }
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

function buildBashLauncher(env: Record<string, string>, cmd: string): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ")
  return `${exports}; ${cmd}`
}

export async function ensureTmuxSession(sessionName: string, spawnCmd = "tmux"): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = nodeSpawn(spawnCmd, ["has-session", "-t", sessionName], { stdio: "ignore" })
    child.on("exit", (code) => {
      if (code === 0) return resolve()
      const mk = nodeSpawn(spawnCmd, ["new-session", "-d", "-s", sessionName], { stdio: "ignore" })
      mk.on("exit", () => resolve())
    })
  })
}

export async function runSpawn(cmd: SpawnCommand): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = nodeSpawn(cmd.argv[0]!, cmd.argv.slice(1), { stdio: "ignore" })
    child.on("exit", (code) => resolve(code ?? -1))
  })
}
