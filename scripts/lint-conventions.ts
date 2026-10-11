import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
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
const CONSTANT_PATTERN = /^[A-Z][A-Z0-9_]+$/
const CONSTANTS_FILE = /(^|\/)constants\.ts$/

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

function collectConstantViolations(file: string, program: BabelNode, violations: Violation[]) {
  if (CONSTANTS_FILE.test(file) || !file.startsWith("src/")) return
  const body = program.body as BabelNode[]
  for (const statement of body) {
    const declaration = (statement.type === "ExportNamedDeclaration" ? statement.declaration : statement) as BabelNode | null
    if (declaration?.type !== "VariableDeclaration") continue
    for (const declarator of declaration.declarations as BabelNode[]) {
      const id = declarator.id as BabelNode & { name?: string }
      const init = declarator.init as BabelNode | null
      if (!id?.name || !CONSTANT_PATTERN.test(id.name)) continue
      if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") continue
      violations.push({ file, line: declarator.loc?.start.line ?? 0, message: `Module-level value "${id.name}" belongs in this directory's constants.ts` })
    }
  }
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
      collectConstantViolations(file, parsed.program, violations)
    }
  }
  if (violations.length === 0) return
  for (const violation of violations) process.stderr.write(`${relative(process.cwd(), violation.file)}:${violation.line} ${violation.message}\n`)
  process.stderr.write(`\n${violations.length} convention violation(s).\n`)
  process.exit(1)
}

run()
