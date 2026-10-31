import type { Body, Message } from "../context/content"

export interface Estimator {
  of: (messages: Message[]) => number
  fixed: number
}

export const DEFAULT_RATIO = 1 / 3.6

const MEDIA_CHARS = 5_800

export function sizeOf(body: Pick<Body, "system" | "tools" | "messages">): number {
  let media = 0
  const json = JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages }, (key, value) => {
    if (key !== "data" || typeof value !== "string" || value.length <= 2_000) return value
    media += 1
    return ""
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
  return size.fixed + 0.3 * Math.max(0, window - size.fixed)
}
