/**
 * Local developer log for the main process.
 *
 * Everything written here must be safe: the redactor scrubs known secret
 * values (Settings overrides and effective .env credentials) before text
 * reaches the console or a log file. Secrets never leave the machine.
 */

type Level = 'info' | 'warn' | 'error'

export interface Redactor {
  /** Replaces any occurrence of a known secret value with a placeholder. */
  redact(text: string): string
  /** Registers/refreshes the set of secret strings that must be scrubbed. */
  setSecrets(secrets: string[]): void
}

export function createRedactor(): Redactor {
  let secrets: string[] = []
  return {
    setSecrets(next) {
      secrets = next.filter((s) => typeof s === 'string' && s.length >= 6)
    },
    redact(text: string): string {
      let out = text
      for (const secret of secrets) {
        out = out.split(secret).join('[redacted]')
      }
      return out
    }
  }
}

export interface Logger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

function formatDetail(redactor: Redactor, detail?: unknown): string {
  if (detail === undefined) return ''
  let serialized: string
  if (typeof detail === 'string') {
    serialized = detail
  } else if (detail instanceof Error) {
    serialized = `${detail.name}: ${detail.message}`
  } else {
    try {
      serialized = JSON.stringify(detail, null, 2)
    } catch {
      serialized = String(detail)
    }
  }
  return redactor.redact(serialized)
}

export function createLogger(redactor: Redactor, prefix = 'flowloom'): Logger {
  const emit = (level: Level, message: string, detail?: unknown) => {
    const line = `[${prefix}] ${redactor.redact(message)}`
    const rendered = formatDetail(redactor, detail)
    const full = rendered ? `${line}\n${rendered}` : line
    if (level === 'error') console.error(full)
    else if (level === 'warn') console.warn(full)
    else console.log(full)
  }
  return {
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d)
  }
}
