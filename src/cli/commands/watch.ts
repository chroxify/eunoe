import { readConfig } from "../../config"
import { runWatch } from "../proxy/watch"
import { line } from "../terminal/ui"
import type { Command } from "../types"

export const watch: Command = {
  summary: "Check the proxy once and unroute Claude Code while it is down",
  usage: "eunoe watch",
  details: ["`eunoe start` schedules this in the background. When the proxy stops answering, Claude Code goes straight to the API; when it is back, routing returns."],
  hidden: true,
  async run() {
    const step = await runWatch(readConfig())
    for (const dir of step.pause) line(`eunoe watch  proxy down, routing removed from ${dir}`)
    for (const dir of step.resume) line(`eunoe watch  proxy back, routing restored in ${dir}`)
  },
}
