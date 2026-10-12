import { existsSync } from "node:fs"
import path from "node:path"
import { type Config, claudeConfigDirs, compactionOwner, modeFor, readConfig, saveConfig } from "../../config"
import { seenSessions } from "../../proxy/sessions"
import type { Command } from "../command"
import { editSettings, withEunoe } from "../proxy/claude-settings"
import { routedDirs } from "../proxy/inspect"
import { isIdle, isTerminal, type LiveSession, listLiveSessions, restartSessions, unroutedSessions } from "../proxy/live"
import { startService } from "../proxy/service"
import { clearWatch } from "../proxy/watch"
import { isKnown, sessionArgs, shortId } from "../sessions"
import { flagValues } from "../terminal/args"
import { c, fail, line, listFiles, note, ok, plural, rows, tilde } from "../terminal/ui"
import { MODE_DESCRIPTIONS } from "./mode"

function scoped(config: Config, ids: string[]): Partial<Config> {
  if (ids.length === 0) return { scope: "all" }
  const managingAll = config.scope === "all" && routedDirs(config).length > 0
  const sessions = { ...config.sessions }
  for (const id of ids) {
    const { mode, ...rest } = sessions[id] ?? {}
    sessions[id] = mode && mode !== "off" ? { mode, ...rest } : rest
  }
  return { scope: managingAll ? "all" : "sessions", sessions }
}

function managedSessions(config: Config): string {
  if (config.scope === "all") return "all"
  const ids = Object.entries(config.sessions)
    .filter(([, own]) => own.mode !== "off")
    .map(([id]) => shortId(id))
  return `only ${ids.join(", ")}`
}

function restartUnrouted(config: Config, skip: boolean): { restarted: LiveSession[]; busy: LiveSession[] } {
  const lastSeen = new Map(seenSessions().map(([id, seen]) => [id, seen.lastSeen]))
  const managed = (id: string) => modeFor(config, id) !== "off"
  const unrouted = unroutedSessions(listLiveSessions(claudeConfigDirs(config)), lastSeen, managed, process.env.CLAUDE_CODE_SESSION_ID)
  if (skip) return { restarted: [], busy: unrouted }
  return { restarted: restartSessions(unrouted.filter(isIdle)), busy: unrouted.filter((session) => !isIdle(session)) }
}

function reportRestarts({ restarted, busy }: { restarted: LiveSession[]; busy: LiveSession[] }) {
  if (restarted.length > 0) {
    ok(`Restarted ${plural(restarted.length, "idle session")} so they go through eunoe`)
    if (restarted.some((session) => !isTerminal(session))) note("App sessions come back on their next message.")
    if (restarted.some(isTerminal)) note("Resume the terminal ones with:")
    for (const session of restarted.filter(isTerminal)) line(`    ${c.dim(`cd ${tilde(session.cwd)} && claude --resume ${session.sessionId}`)}`)
    line()
  }
  if (busy.length > 0) note(`Still on the direct route until restarted: ${busy.map((session) => shortId(session.sessionId)).join(", ")}.`)
}

export const start: Command = {
  summary: "Route Claude Code through eunoe",
  usage: "eunoe start [--session <id>] [--config-dir <dir>] [--no-restart]",
  details: [
    "Starts the background proxy if it isn't running (setting it up the first time)",
    "and points Claude Code at it through ANTHROPIC_BASE_URL in settings.json.",
    "New sessions pick it up. Idle sessions already running are restarted so they",
    "pick it up too: app-hosted ones resume on their next message, terminal ones",
    "print the command that resumes them. Busy sessions are left alone.",
    "",
    "With --session, eunoe manages only the sessions you name and passes the rest",
    "through untouched. Session ids are in Claude Code's /status, or `eunoe status`.",
  ],
  options: [
    ["--session <id>", "Only manage this session (repeatable; a unique prefix is enough)"],
    ["--config-dir <dir>", "Also manage this Claude config directory (repeatable, remembered)"],
    ["--no-restart", "Leave running sessions alone"],
  ],
  async run(args) {
    const added = flagValues(args, "--config-dir").map((dir) => path.resolve(dir))
    for (const dir of added) if (!existsSync(dir)) fail(`No such directory: ${tilde(dir)}`)
    if (added.length > 0) saveConfig({ claudeConfigDirs: [...new Set([...readConfig().claudeConfigDirs, ...added])] })
    const ids = sessionArgs(args)
    saveConfig(scoped(readConfig(), ids))
    const config = readConfig()

    line()
    if (!(await startService(config))) fail("Claude Code was left alone because the proxy isn't up.", "Nothing is routed through a proxy that can't answer. Fix the proxy and run `eunoe start` again.")
    clearWatch()
    const touched = editSettings(claudeConfigDirs(config), (settings) => withEunoe(settings, config.port, compactionOwner(config)))
    ok("Claude Code routed through eunoe")
    listFiles(touched.length > 0 ? touched : routedDirs(config).map((dir) => path.join(dir, "settings.json")))
    line()
    rows([
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      ["Sessions", managedSessions(config)],
    ])
    line()
    const restarts = restartUnrouted(config, args.includes("--no-restart"))
    reportRestarts(restarts)
    const unseen = ids.filter((id) => !isKnown(id) && !restarts.restarted.some((session) => session.sessionId === id))
    if (unseen.length > 0) note(`Not seen through eunoe yet: ${unseen.map(shortId).join(", ")}. It applies once that session's requests come through; one started before routing needs a restart.`)
    else note(ids.length > 0 ? "Takes effect on the session's next request." : "New sessions go through eunoe.")
    line()
  },
}
