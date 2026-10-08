function balancedObject(source: string): string | null {
  const start = source.indexOf("{")
  let depth = 0
  let inString = false
  for (let i = start; i >= 0 && i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (char === "\\") i += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1)
  }
  return null
}

/** The first JSON object in a model reply: the raw text first, then a fenced block, with trailing commas tolerated. */
export function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  for (const source of [raw, fenced?.[1]]) {
    const object = source && balancedObject(source)
    if (!object) continue
    try { return JSON.parse(object) } catch {}
    try { return JSON.parse(object.replace(/,\s*([\]}])/g, "$1")) } catch {}
  }
  throw new Error("no JSON object found")
}
