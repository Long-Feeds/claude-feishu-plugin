import { readFileSync } from "fs"
import { join } from "path"

const FILES = ["SOUL.md", "USER.md", "FEISHU.md", "AGENTS.md"] as const

export function loadBootstrap(stateDir: string): string {
  const dir = join(stateDir, "workspace")
  const sections: string[] = []
  for (const name of FILES) {
    let body: string
    try {
      body = readFileSync(join(dir, name), "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        process.stderr.write(`bootstrap: failed to read ${name}: ${(e as Error).message}\n`)
      }
      continue
    }
    const trimmed = body.trim()
    if (!trimmed) continue
    sections.push(`## ${name.replace(/\.md$/, "")}\n${trimmed}`)
  }
  if (!sections.length) return ""
  return `# Feishu Channel Bootstrap\n\n${sections.join("\n\n")}\n\n---\n\n# User Message\n\n`
}
