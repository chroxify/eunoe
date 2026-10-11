import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

export interface Agent {
  label: string
  plist: string
  interval?: number
}

export const supported = process.platform === "darwin"

export function isInstalled(agent: Agent) {
  return existsSync(agent.plist)
}

function plistFor(agent: Agent, program: string[], logFile: string) {
  const args = program.map((arg) => `<string>${arg}</string>`).join("")
  const schedule = agent.interval ? `<key>StartInterval</key><integer>${agent.interval}</integer>` : `<key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>1</integer>`
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

export function installAgent(agent: Agent, program: string[], logFile: string) {
  mkdirSync(path.dirname(agent.plist), { recursive: true })
  const plist = plistFor(agent, program, logFile)
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
