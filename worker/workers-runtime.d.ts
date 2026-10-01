// Ambient Workers runtime types this Worker uses (no @cloudflare/workers-types dependency).

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>
}

interface DurableObjectStorage {
  sql: SqlStorage
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  /** SQLite-backed objects: run `callback` as one transaction (rolled back if it throws). */
  transactionSync?<T>(callback: () => T): T
}

interface HibernatingWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void
  deserializeAttachment<T>(): T | null
}

interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): void
  acceptWebSocket(socket: HibernatingWebSocket): void
  getWebSockets(): HibernatingWebSocket[]
}

declare class WebSocketPair {
  0: WebSocket
  1: HibernatingWebSocket
}
