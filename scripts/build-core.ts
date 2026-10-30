import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const OUT = "dist"
const TYPES = path.join(OUT, "types")
const RELATIVE_SPECIFIER = /(from\s+|import\(\s*)"(\.{1,2}(?:\/[^"]*)?)"/g

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) process.exit(1)
}

function listDeclarations(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry)
    if (statSync(file).isDirectory()) return listDeclarations(file)
    return file.endsWith(".d.ts") ? [file] : []
  })
}

function resolveSpecifier(file: string, specifier: string): string {
  const target = path.resolve(path.dirname(file), specifier)
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`
  if (existsSync(path.join(target, "index.d.ts"))) return `${specifier}/index.js`
  throw new Error(`${file}: cannot resolve "${specifier}"`)
}

rmSync(OUT, { recursive: true, force: true })
await run(["bun", "build", "src/core/index.ts", "--target=node", "--format=esm", "--outfile", path.join(OUT, "core", "index.js")])
await run(["bunx", "tsc", "-p", "tsconfig.core.json"])
for (const file of listDeclarations(TYPES)) {
  const source = readFileSync(file, "utf8")
  writeFileSync(
    file,
    source.replace(RELATIVE_SPECIFIER, (_, lead: string, specifier: string) => `${lead}"${resolveSpecifier(file, specifier)}"`),
  )
}
