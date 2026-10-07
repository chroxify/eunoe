import type { Body, Message } from "../context/types"
import { MEDIA_CHARS, MEDIA_MIN_LENGTH, TARGET_SHARE } from "./constants"
import type { Estimator } from "./types"

export function sizeOf(body: Pick<Body, "system" | "tools" | "messages">): number {
  let media = 0
  const json = JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages }, (key, value) => {
    if (key === "data" && typeof value === "string" && value.length > MEDIA_MIN_LENGTH) {
      media += 1
      return ""
    }
    return value
  })
  return json.length + media * MEDIA_CHARS
}

export function estimator(body: Body, ratio: number): Estimator {
  return {
    of: (messages: Message[]) => Math.round(sizeOf({ ...body, messages }) * ratio),
    fixed: Math.round(sizeOf({ ...body, messages: [] }) * ratio),
  }
}

export function targetSize(size: Estimator, window: number): number {
  return size.fixed + TARGET_SHARE * Math.max(0, window - size.fixed)
}
