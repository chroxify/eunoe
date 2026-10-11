import { homedir } from "node:os"
import path from "node:path"

export const EUNOE_DIR = process.env.EUNOE_DIR ?? path.join(homedir(), ".eunoe")

export const paths = {
  config: path.join(EUNOE_DIR, "config.json"),
  requests: path.join(EUNOE_DIR, "requests.jsonl"),
  threads: path.join(EUNOE_DIR, "threads"),
  transcripts: path.join(EUNOE_DIR, "transcripts"),
  models: path.join(EUNOE_DIR, "models.json"),
  sessions: path.join(EUNOE_DIR, "sessions.json"),
  proxyLog: path.join(EUNOE_DIR, "proxy.log"),
  typesafeKey: path.join(EUNOE_DIR, "typesafe-key"),
  loaded: path.join(EUNOE_DIR, "loaded"),
  watch: path.join(EUNOE_DIR, "watch.json"),
}
