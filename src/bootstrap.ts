import { readFileSync } from "fs"
import { join } from "path"

const FILES = ["SOUL.md", "USER.md", "FEISHU.md", "AGENTS.md"] as const
const PER_FILE_CAP = 32 * 1024
const AGG_CAP = 64 * 1024

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
    if (Buffer.byteLength(body, "utf8") > PER_FILE_CAP) {
      process.stderr.write(`bootstrap: ${name} exceeds 32KB cap, truncating\n`)
      const buf = Buffer.from(body, "utf8").subarray(0, PER_FILE_CAP)
      body = buf.toString("utf8")
    }
    const trimmed = body.trim()
    if (!trimmed) continue
    sections.push(`## ${name.replace(/\.md$/, "")}\n${trimmed}`)
  }
  if (!sections.length) return ""

  const dropped: string[] = []
  while (sections.length > 1 && Buffer.byteLength(sections.join("\n\n"), "utf8") > AGG_CAP) {
    const popped = sections.pop()!
    const sectionName = popped.split("\n", 1)[0]!.replace(/^## /, "")
    dropped.push(sectionName)
  }
  if (dropped.length) {
    process.stderr.write(`bootstrap: aggregate exceeds 64KB cap, dropped sections: ${dropped.reverse().join(", ")}\n`)
  }

  return `# Feishu Channel Bootstrap\n\n${sections.join("\n\n")}\n\n---\n\n# User Message\n\n`
}
