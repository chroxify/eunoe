import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { LAUNCH_AGENT_PLIST as PLIST, LAUNCHD_LABEL } from "./constants"

export const supported = process.platform === "darwin"

export function isInstalled() {
  return existsSync(PLIST)
}

export function installAgent(program: string[], logFile: string) {
  mkdirSync(path.dirname(PLIST), { recursive: true })
  const args = program.map((arg) => `<string>${arg}</string>`).join("")
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`)
  Bun.spawnSync(["launchctl", "unload", PLIST])
  Bun.spawnSync(["launchctl", "load", PLIST])
}

export function removeAgent() {
  if (!existsSync(PLIST)) return false
  Bun.spawnSync(["launchctl", "unload", PLIST])
  unlinkSync(PLIST)
  return true
}
