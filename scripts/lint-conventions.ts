import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { parse } from "@babel/parser"

interface Violation {
  file: string
  line: number
  message: string
}

interface BabelComment {
  value: string
  loc: { start: { line: number } }
}

interface BabelNode {
  type: string
  loc?: { start: { line: number } }
  [key: string]: unknown
}

const ROOTS = ["src", "test", "bench", "scripts"]
const SKIPPED_SEGMENTS = new Set(["node_modules", "out", "models"])
const VERB_CHECK_ROOTS = ["src"]
const BANNED_VERB_PATTERN = /^(get|fetch|load|set|delete|destroy)[A-Z]/
const BANNED_VERB_ALLOWLIST = new Set<string>()
const ALLOWED_COMMENT_PATTERN = /^\s*(biome-ignore|@ts-|#region|#endregion)/
const GRAB_BAG_FILE = /(^|\/)(constants|types)\.ts$/
const PORTABLE_ROOTS = ["src/core", "src/context"]
const HOST_ONLY_IMPORT = /^(node:|bun$|bun:)/
const HOST_ONLY_MODULES = ["src/proxy", "src/cli", "src/transcript", "src/config"]
const HOST_ONLY_GLOBALS = new Set(["Bun", "process"])

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    if (SKIPPED_SEGMENTS.has(entry)) continue
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(path)
  }
  return files
}

function collectCommentViolations(file: string, comments: BabelComment[], violations: Violation[]) {
  for (const comment of comments) {
    const inner = comment.value.trim()
    if (inner.length === 0 || ALLOWED_COMMENT_PATTERN.test(inner)) continue
    violations.push({ file, line: comment.loc.start.line, message: `Comment found; names and structure carry the meaning, CLAUDE.md and docs carry the rest: "${inner.slice(0, 60)}"` })
  }
}

function declaredFunctionName(node: BabelNode): { name: string; line: number } | null {
  if (node.type === "FunctionDeclaration") {
    const id = node.id as BabelNode & { name: string }
    if (id?.name) return { name: id.name, line: id.loc?.start.line ?? 0 }
  }
  if (node.type === "VariableDeclarator") {
    const id = node.id as BabelNode & { name?: string }
    const init = node.init as BabelNode | null
    const isFunction = init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression"
    if (id?.type === "Identifier" && id.name && isFunction) return { name: id.name, line: id.loc?.start.line ?? 0 }
  }
  return null
}

function walk(node: BabelNode, visit: (node: BabelNode) => void) {
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === "object" && "type" in child) walk(child as BabelNode, visit)
      continue
    }
    if (value && typeof value === "object" && "type" in value) walk(value as BabelNode, visit)
  }
}

function collectVerbViolations(file: string, program: BabelNode, violations: Violation[]) {
  walk(program, (node) => {
    const declaration = declaredFunctionName(node)
    if (!declaration || !BANNED_VERB_PATTERN.test(declaration.name) || BANNED_VERB_ALLOWLIST.has(declaration.name)) return
    violations.push({ file, line: declaration.line, message: `Banned verb prefix on "${declaration.name}"; use read*/find*/list*/resolve*/create*/update*/save*/remove*/apply*/record*` })
  })
}

function isTypeOnly(node: BabelNode): boolean {
  if (node.importKind === "type" || node.exportKind === "type") return true
  const specifiers = (node.specifiers as BabelNode[] | undefined) ?? []
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type" || specifier.exportKind === "type")
}

function hostOnlySource(file: string, source: string): boolean {
  if (HOST_ONLY_IMPORT.test(source)) return true
  if (!source.startsWith(".")) return false
  const target = relative(process.cwd(), resolve(dirname(file), source))
  return HOST_ONLY_MODULES.some((root) => target === root || target.startsWith(`${root}/`))
}

function collectPortabilityViolations(file: string, program: BabelNode, violations: Violation[]) {
  walk(program, (node) => {
    const source = (node.source as { value?: string } | undefined)?.value
    const line = node.loc?.start.line ?? 0
    if (source && /^(Import|ExportNamed|ExportAll)Declaration$/.test(node.type) && !isTypeOnly(node) && hostOnlySource(file, source)) {
      violations.push({ file, line, message: `"${source}" is host-only; src/core and src/context must run in any JavaScript runtime, so take it through an interface instead` })
    }
    const object = node.object as BabelNode & { name?: string }
    if (node.type === "MemberExpression" && object?.type === "Identifier" && HOST_ONLY_GLOBALS.has(object.name ?? "")) {
      violations.push({ file, line, message: `${object.name} is host-only; src/core and src/context must run in any JavaScript runtime` })
    }
  })
}

function collectGrabBagViolations(file: string, violations: Violation[]) {
  if (!GRAB_BAG_FILE.test(file)) return
  violations.push({ file, line: 1, message: "No constants.ts or types.ts: a value or type lives in the file that uses it, or in the module that owns it" })
}

function run() {
  const violations: Violation[] = []
  for (const root of ROOTS) {
    for (const file of listSourceFiles(root)) {
      let parsed: { program: BabelNode; comments?: BabelComment[] | null }
      try {
        parsed = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript"], attachComment: false }) as unknown as typeof parsed
      } catch (error) {
        violations.push({ file, line: 1, message: `Could not parse: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      collectCommentViolations(file, parsed.comments ?? [], violations)
      if (VERB_CHECK_ROOTS.some((verbRoot) => file.startsWith(verbRoot))) collectVerbViolations(file, parsed.program, violations)
      if (PORTABLE_ROOTS.some((portableRoot) => file.startsWith(`${portableRoot}/`))) collectPortabilityViolations(file, parsed.program, violations)
      collectGrabBagViolations(file, violations)
    }
  }
  if (violations.length === 0) return
  for (const violation of violations) process.stderr.write(`${relative(process.cwd(), violation.file)}:${violation.line} ${violation.message}\n`)
  process.stderr.write(`\n${violations.length} convention violation(s).\n`)
  process.exit(1)
}

run()
