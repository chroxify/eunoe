export const RECALL_REMINDERS = /<(system-reminder|system-message|recalled-context|tool-evidence)>[\s\S]*?<\/\1>/g
export const RECALL_WINDOW_LINES = 6
export const RECALL_SHOWN_LINES = 8
export const RECALL_PER_QUERY = 12
export const RECALL_MAX_CHARS = 18_000
export const RECALL_MAX_CHARS_MULTI = 30_000
export const RECALL_MIN_TERMS = 2
export const RECALL_SALIENT_EXCERPT = true
export const RECALL_NARRATIVE = true
export const RECALL_LINE_CHARS = 240
export const RECALL_RERANK_CANDIDATES = 30

export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const STOPWORDS = new Set(
  "the and for with that this what which when where who how was were did does done from into onto have has had you your our out not but are can could would should will just then than them they there their its it's about after before again also any each other some such only own same very more most over under while because been being into".split(
    " ",
  ),
)

export const RERANK_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const RERANK_TIMEOUT_MS = 4_000
export const RERANK_LINE_CHARS = 240
