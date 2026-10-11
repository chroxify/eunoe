import { foldedTurns, foldedView } from "../../src/context/fold"
import { sessionMessages } from "../../src/transcript/messages"

for (const file of process.argv.slice(2)) {
  const messages = sessionMessages(file)
  const turns = foldedTurns(messages)
  const view = foldedView(messages)
  const capped = foldedView(messages, 80_000)
  const withEvidence = turns.filter((t) => t.evidence).length
  const emptyReply = turns.filter((t) => !t.reply).length
  console.log(
    `${file.split("/").pop()!.slice(0, 8)}  turns ${turns.length}  evidence-turns ${withEvidence}  empty-reply ${emptyReply}  full ${(view.length / 1000).toFixed(0)}k chars  capped80k ${(capped.length / 1000).toFixed(0)}k  ~tokens ${(view.length / 3.6 / 1000).toFixed(0)}k`,
  )
  console.log(`  first turn: ${view.slice(0, 220).replace(/\n/g, " ⏎ ")}`)
}
