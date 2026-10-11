import { clip } from "../context/content"
import type { ToolPart, TranscriptFormat, Turn } from "./parse"
import type { SubagentRun } from "./subagents"

export interface SubagentRecord {
  run: SubagentRun
  turns: Turn[]
  parentTurn: number
  file: string
}

const extension = (format: TranscriptFormat) => (format === "xml" ? "xml" : "md")
const padded = (n: number) => String(n).padStart(4, "0")
const calls = (count: number) => `${count} tool call${count === 1 ? "" : "s"}`

export function turnFile(turn: Turn, format: TranscriptFormat) {
  return `turn-${padded(turn.number)}.${extension(format)}`
}

export function subagentFile(parentTurn: number, k: number, format: TranscriptFormat) {
  return `turn-${padded(parentTurn)}-subagent-${k}.${extension(format)}`
}

function toolMarkdown(part: ToolPart, total: number) {
  return [
    `### [tool ${part.n}/${total}] ${part.name}: ${part.call}`,
    part.record ? `Full record of this subagent run: ${part.record}` : "",
    part.body,
    part.output ? `[output of tool ${part.n}${part.error ? ", error" : ""}]\n\`\`\`\n${part.output}\n\`\`\`` : `[tool ${part.n}: no output]`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function workOf(turn: Turn) {
  const work = turn.parts.map((part) => (part.kind === "say" ? `> ${part.text.replace(/\n/g, "\n> ")}` : toolMarkdown(part, turn.calls)))
  return work.join("\n\n") || "_No tool calls._"
}

export function renderMarkdown(turn: Turn) {
  return [
    `# Turn ${turn.number}${turn.time ? ` · ${turn.time}` : ""}`,
    "",
    "## User",
    "",
    turn.prompt,
    "",
    `## Work (${calls(turn.calls)})`,
    "",
    workOf(turn),
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

function toolXml(part: ToolPart, total: number) {
  return [
    `<tool n="${part.n}" of="${total}" name="${attr(part.name)}">`,
    `<call>${part.call.replace(/^`|`$/g, "")}</call>`,
    part.record ? `<record>${part.record}</record>` : "",
    part.body ? `<input>\n${part.body}\n</input>` : "",
    part.output ? `<output${part.error ? ' error="true"' : ""}>\n${part.output}\n</output>` : "<output/>",
    "</tool>",
  ]
    .filter(Boolean)
    .join("\n")
}

export function renderXml(turn: Turn) {
  return [
    `<turn n="${turn.number}"${turn.time ? ` time="${turn.time}"` : ""} tool_calls="${turn.calls}">`,
    `<user>\n${turn.prompt}\n</user>`,
    ...turn.parts.map((part) => (part.kind === "say" ? `<said>\n${part.text}\n</said>` : toolXml(part, turn.calls))),
    turn.final ? `<final_reply>\n${turn.final}\n</final_reply>` : `<final_reply interrupted="true"/>`,
    "</turn>",
    "",
  ].join("\n")
}

const finalOf = (final: string | undefined) => (final ? clip(final, 160) : "_(no final reply)_")

const turnLine = (turn: Turn, format: TranscriptFormat) => `- **${turnFile(turn, format)}** (${turn.time}, ${turn.calls} calls): ${clip(turn.prompt, 140)} → ${finalOf(turn.final)}`

const recordLine = (record: SubagentRecord) => {
  const total = record.turns.reduce((sum, turn) => sum + turn.calls, 0)
  return `  - **${record.file}**: subagent "${clip(record.run.description, 140)}" (${total} calls) → ${finalOf(record.turns.at(-1)?.final)}`
}

export function renderIndex(turns: Turn[], format: TranscriptFormat, records: SubagentRecord[] = []) {
  const ext = extension(format)
  const subagentNote = records.length > 0 ? ` Indented lines are subagents the agent launched in that turn; turn-NNNN-subagent-K.${ext} holds the subagent's whole run, which the turn itself only has the report of.` : ""
  return [
    "# Session index",
    "",
    `One line per turn: what the user asked → how the turn ended. Open turn-NNNN.${ext} for everything that happened in it.${subagentNote}`,
    "",
    ...turns.flatMap((turn) => [turnLine(turn, format), ...records.filter((record) => record.parentTurn === turn.number).map(recordLine)]),
    ...records.filter((record) => record.parentTurn === 0).map(recordLine),
    "",
  ].join("\n")
}

export function renderSubagentMarkdown(record: SubagentRecord) {
  const parent = record.parentTurn || "?"
  const body = record.turns.flatMap((turn, i) => [
    record.turns.length > 1 ? `## Message ${i + 1}` : "## Task",
    "",
    turn.prompt,
    "",
    `## Work (${calls(turn.calls)})`,
    "",
    workOf(turn),
    "",
    "## Final reply",
    "",
    turn.final || "_No final reply: the run was interrupted or is still going._",
    "",
  ])
  return [`# Subagent of turn ${parent} · "${record.run.description}"`, `This is the full record of a subagent launched from turn ${parent}; that turn only holds its final report.`, "", ...body].join("\n")
}

export function renderSubagentXml(record: SubagentRecord) {
  return [`<subagent parent_turn="${record.parentTurn}" description="${attr(record.run.description)}">`, ...record.turns.map(renderXml), "</subagent>", ""].join("\n")
}
