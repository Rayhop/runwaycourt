/**
 * Load .env.local into process.env for standalone scripts.
 *
 * Next.js does this automatically for the app, but these scripts run under tsx
 * outside Next, so without this every process.env read is undefined -- which
 * looks exactly like "you forgot to set the key".
 *
 * Import this FIRST in any script that reads configuration:
 *
 *   import "./load-env"
 *
 * Precedence matches Next: .env.local wins over .env, and a variable already
 * present in the real environment always wins over both (so
 * `FILECOIN_NETWORK=mainnet npm run …` still overrides the file).
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Files are applied in order; earlier ones win. */
const FILES = [".env.local", ".env"]

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    // Tolerate `export FOO=bar`, which people paste in from shell notes.
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line

    const eq = withoutExport.indexOf("=")
    if (eq === -1) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!key) continue

    let value = withoutExport.slice(eq + 1).trim()

    // Strip a single matching pair of surrounding quotes, and only then honour
    // escapes -- an unquoted value is taken literally, backslashes and all.
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r")
    }

    out[key] = value
  }

  return out
}

let loadedFrom: string[] = []

for (const file of FILES) {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) continue

  const values = parse(readFileSync(path, "utf8"))
  let applied = 0

  for (const [key, value] of Object.entries(values)) {
    // Never clobber something already exported in the real environment.
    if (process.env[key] === undefined) {
      process.env[key] = value
      applied++
    }
  }

  if (applied > 0) loadedFrom.push(`${file} (${applied})`)
}

if (process.env.RUNWAYCOURT_ENV_DEBUG === "1") {
  console.error(
    loadedFrom.length > 0
      ? `[load-env] loaded ${loadedFrom.join(", ")}`
      : "[load-env] no .env.local or .env found",
  )
}

export {}
