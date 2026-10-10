import { ARMS } from "./constants"

export interface ArmSpec {
  name: string
  proxy: string
  port: number
  native?: boolean
  uncut?: boolean
  config: Record<string, unknown>
}

export function armSpec(name: string): ArmSpec {
  const spec = ARMS.find((a) => a.name === name)
  if (!spec) throw new Error(`unknown arm ${name}; known: ${ARMS.map((a) => a.name).join(", ")}`)
  return spec
}
