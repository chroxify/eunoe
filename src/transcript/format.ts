import { clip } from "../context/content"
import { INDEX_PROMPT_CHARS, INDEX_REPLY_CHARS } from "./constants"
import type { TranscriptFormat, Turn } from "./types"

export function turnFile(turn: Turn, format: TranscriptFormat) {
  return `turn-${String(turn.number).padStart(4, "0")}.${format === "xml" ? "xml" : "md"}`
}

export function renderMarkdown(turn: Turn) {
  const work = turn.parts.map((part) => part.kind === "say"
    ? `> ${part.text.replace(/\n/g, "\n> ")}`
    : [
        `### [tool ${part.n}/${turn.calls}] ${part.name}: ${part.call}`,
        part.body,
        part.output ? `[output of tool ${part.n}${part.error ? ", error" : ""}]\n\`\`\`\n${part.output}\n\`\`\`` : `[tool ${part.n}: no output]`,
      ].filter(Boolean).join("\n\n"))
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
  const work = turn.parts.map((part) => part.kind === "say"
    ? `<said>\n${part.text}\n</said>`
    : [
        `<tool n="${part.n}" of="${turn.calls}" name="${attr(part.name)}">`,
        `<call>${part.call.replace(/^`|`$/g, "")}</call>`,
        part.body ? `<input>\n${part.body}\n</input>` : "",
        part.output ? `<output${part.error ? ' error="true"' : ""}>\n${part.output}\n</output>` : "<output/>",
        "</tool>",
      ].filter(Boolean).join("\n"))
  return [
    `<turn n="${turn.number}"${turn.time ? ` time="${turn.time}"` : ""} tool_calls="${turn.calls}">`,
    `<user>\n${turn.prompt}\n</user>`,
    ...work,
    turn.final ? `<final_reply>\n${turn.final}\n</final_reply>` : `<final_reply interrupted="true"/>`,
    "</turn>",
    "",
  ].join("\n")
}

export function renderIndex(turns: Turn[], format: TranscriptFormat) {
  return [
    "# Session index",
    "",
    `One line per turn: what the user asked → how the turn ended. Open turn-NNNN.${format === "xml" ? "xml" : "md"} for everything that happened in it.`,
    "",
    ...turns.map((turn) => `- **${turnFile(turn, format)}** (${turn.time}, ${turn.calls} calls): ${clip(turn.prompt, INDEX_PROMPT_CHARS)} → ${turn.final ? clip(turn.final, INDEX_REPLY_CHARS) : "_(no final reply)_"}`),
    "",
  ].join("\n")
}
