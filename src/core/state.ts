export interface Handoff {
  label: string
  source: string
  text: string
}

export interface ThreadState {
  handoffs?: Record<string, Handoff | null>
  cut?: string
  keep?: number
  cleared?: number
  stuck?: number
  host?: boolean
  pins?: string[]
  ratio?: number
  recalls?: Record<string, string>
}

export interface ThreadStore {
  read: (key: string) => ThreadState
  save: (key: string, state: ThreadState) => void
}

export function memoryStore(initial: Record<string, ThreadState> = {}): ThreadStore {
  const threads = new Map(Object.entries(initial).map(([key, state]) => [key, structuredClone(state)]))
  return {
    read: (key) => structuredClone(threads.get(key) ?? {}),
    save: (key, state) => {
      threads.set(key, structuredClone(state))
    },
  }
}

export function resetCut(state: ThreadState) {
  delete state.cut
  delete state.keep
  delete state.cleared
  delete state.stuck
  delete state.host
}
