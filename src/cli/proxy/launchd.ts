import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RESTART_THROTTLE_S } from "./constants"
import type { Agent } from "./types"

export const supported = process.platform === "darwin"

export function isInstalled(agent: Agent) {
  return existsSync(agent.plist)
}

export function installAgent(agent: Agent, program: string[], logFile: string) {
  mkdirSync(path.dirname(agent.plist), { recursive: true })
  const args = program.map((arg) => `<string>${arg}</string>`).join("")
  const schedule = agent.interval ? `<key>StartInterval</key><integer>${agent.interval}</integer>` : `<key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>${RESTART_THROTTLE_S}</integer>`
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${agent.label}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
  ${schedule}
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`
  if (existsSync(agent.plist) && readFileSync(agent.plist, "utf8") === plist) {
    Bun.spawnSync(["launchctl", "load", agent.plist])
    return
  }
  writeFileSync(agent.plist, plist)
  Bun.spawnSync(["launchctl", "unload", agent.plist])
  Bun.spawnSync(["launchctl", "load", agent.plist])
}

export function restartAgent(agent: Agent) {
  Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? ""}/${agent.label}`])
}

export function removeAgent(agent: Agent) {
  if (!existsSync(agent.plist)) return false
  Bun.spawnSync(["launchctl", "unload", agent.plist])
  unlinkSync(agent.plist)
  return true
}
