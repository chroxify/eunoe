import type { Message } from "../../context/types"

export interface SessionCandidate {
  id: string
  file: string
  label: string
  mtime: number
  asks: string[]
  outline: string
  messages: Message[]
}
