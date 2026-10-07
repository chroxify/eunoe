import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.EUNOE_DIR = mkdtempSync(path.join(tmpdir(), "eunoe-test-"))
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "eunoe-claude-"))
