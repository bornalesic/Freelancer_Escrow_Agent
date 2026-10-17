/** Errors with an HTTP status; the error handler turns them into `{ error, details }`. */
export class HttpError extends Error {
  readonly statusCode: number
  readonly details: unknown

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.details = details
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Reject if `p` does not settle within `ms` (root CLAUDE.md rule 8: nothing may hang forever). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new TimeoutError(`${label} timed out after ${ms} ms`)) }, ms)
  })
  return Promise.race([p, timeout]).finally(() => { clearTimeout(timer) })
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })
