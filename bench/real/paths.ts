import path from "node:path"

export const OUT = path.join(import.meta.dir, "..", "out", "real")

export const PROXIES = path.join(OUT, "proxies")
