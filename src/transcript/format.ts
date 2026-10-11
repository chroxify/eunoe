import { clip } from "../context/content"
import { INDEX_PROMPT_CHARS, INDEX_REPLY_CHARS } from "./constants"
import type { SubagentRecord, TranscriptFormat, Turn } from "./types"

export function turnFile(turn: Turn, format: TranscriptFormat) {
  return `turn-${String(turn.number).padStart(4, "0")}.${format === "xml" ? "xml" : "md"}`
}

export function subagentFile(parentTurn: number, k: number, format: TranscriptFormat) {
  return `turn-${String(parentTurn).padStart(4, "0")}-subagent-${k}.${format === "xml" ? "xml" : "md"}`
}

function workOf(turn: Turn) {
  return turn.parts.map((part) =>
    part.kind === "say"
      ? `> ${part.text.replace(/\n/g, "\n> ")}`
      : [
          `### [tool ${part.n}/${turn.calls}] ${part.name}: ${part.call}`,
          part.record ? `Full record of this subagent run: ${part.record}` : "",
          part.body,
          part.output ? `[output of tool ${part.n}${part.error ? ", error" : ""}]\n\`\`\`\n${part.output}\n\`\`\`` : `[tool ${part.n}: no output]`,
        ]
          .filter(Boolean)
          .join("\n\n"),
  )
}

export function renderMarkdown(turn: Turn) {
  const work = workOf(turn)
  return [
    `# Turn ${turn.number}${turn.time ? ` · ${turn.time}` : ""}`,
    "",
    "## User",
    "",
    turn.prompt,
    "",
    `## Work (${turn.calls} tool call${turn.calls === 1 ? "" : "s"})`,
    "",
    work.join("\n\n") || "_No tool calls._",
    "",
    "## Final reply",
    "",
    turn.final || "_No final reply: the turn was interrupted or is still running._",
    "",
  ].join("\n")
}

function attr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ")
}

export function renderXml(turn: Turn) {
  const work = turn.parts.map((part) =>
    part.kind === "say"
      ? `<said>\n${part.text}\n</said>`
      : [
          `<tool n="${part.n}" of="${turn.calls}" name="${attr(part.name)}">`,
          `<call>${part.call.replace(/^`|`$/g, "")}</call>`,
          part.record ? `<record>${part.record}</record>` : "",
          part.body ? `<input>\n${part.body}\n</input>` : "",
          part.output ? `<output${part.error ? ' error="true"' : ""}>\n${part.output}\n</output>` : "<output/>",
          "</tool>",
        ]
          .filter(Boolean)
          .join("\n"),
  )
  return [
    `<turn n="${turn.number}"${turn.time ? ` time="${turn.time}"` : ""} tool_calls="${turn.calls}">`,
    `<user>\n${turn.prompt}\n</user>`,
    ...work,
    turn.final ? `<final_reply>\n${turn.final}\n</final_reply>` : `<final_reply interrupted="true"/>`,
    "</turn>",
    "",
  ].join("\n")
}

const turnLine = (turn: Turn, format: TranscriptFormat) =>
  `- **${turnFile(turn, format)}** (${turn.time}, ${turn.calls} calls): ${clip(turn.prompt, INDEX_PROMPT_CHARS)} → ${turn.final ? clip(turn.final, INDEX_REPLY_CHARS) : "_(no final reply)_"}`

const recordLine = (record: SubagentRecord) => {
  const calls = record.turns.reduce((sum, turn) => sum + turn.calls, 0)
  const final = record.turns.at(-1)?.final
  return `  - **${record.file}**: subagent "${clip(record.run.description, INDEX_PROMPT_CHARS)}" (${calls} calls) → ${final ? clip(final, INDEX_REPLY_CHARS) : "_(no final reply)_"}`
}

export function renderIndex(turns: Turn[], format: TranscriptFormat, records: SubagentRecord[] = []) {
  const ext = format === "xml" ? "xml" : "md"
  const orphans = records.filter((record) => record.parentTurn === 0)
  return [
    "# Session index",
    "",
    `One line per turn: what the user asked → how the turn ended. Open turn-NNNN.${ext} for everything that happened in it.${records.length > 0 ? ` Indented lines are subagents the agent launched in that turn; turn-NNNN-subagent-K.${ext} holds the subagent's whole run, which the turn itself only has the report of.` : ""}`,
    "",
    ...turns.flatMap((turn) => [turnLine(turn, format), ...records.filter((record) => record.parentTurn === turn.number).map(recordLine)]),
    ...orphans.map(recordLine),
    "",
  ].join("\n")
}

export function renderSubagentMarkdown(record: SubagentRecord) {
  const head = `# Subagent of turn ${record.parentTurn || "?"} · "${record.run.description}"`
  const body = record.turns.flatMap((turn, i) => [
    record.turns.length > 1 ? `## Message ${i + 1}` : "## Task",
    "",
    turn.prompt,
    "",
    `## Work (${turn.calls} tool call${turn.calls === 1 ? "" : "s"})`,
    "",
    workOf(turn).join("\n\n") || "_No tool calls._",
    "",
    "## Final reply",
    "",
    turn.final || "_No final reply: the run was interrupted or is still going._",
    "",
  ])
  return [head, `This is the full record of a subagent launched from turn ${record.parentTurn || "?"}; that turn only holds its final report.`, "", ...body].join("\n")
}

export function renderSubagentXml(record: SubagentRecord) {
  return [`<subagent parent_turn="${record.parentTurn}" description="${attr(record.run.description)}">`, ...record.turns.map(renderXml), "</subagent>", ""].join("\n")
}
