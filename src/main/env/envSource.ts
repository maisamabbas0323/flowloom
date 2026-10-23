import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from 'dotenv'

/**
 * The environment source for the configuration service.
 *
 * Reads a real `.env` file — never writes to it. Candidate locations, in
 * order: an explicit `FLOWLOOM_ENV_PATH`, a `.env` inside the OS application
 * configuration directory (`userData`), and, for unpackaged runs (dev,
 * preview, or a direct `electron out/` launch), a `.env` in the project
 * root. The first existing file wins.
 *
 * Known keys from the real OS environment are additionally honored so the
 * same variable names keep working when no `.env` file exists; when both
 * exist, the `.env` file wins so the visible file is the source of truth.
 */
export interface EnvSource {
  /** Absolute path of the active .env file, or null when none was found. */
  getPath(): string | null
  /** Effective values for Flowloom's supported variables (file + OS env). */
  read(): Record<string, string>
}

export const ENV_KEYS = [
  'FLOWLOOM_MODEL_PROVIDER',
  'FLOWLOOM_MODEL_ID',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'PAPERINSTRUMENTS_API_KEY',
  'PAPERINSTRUMENTS_MODEL'
] as const

export type EnvKey = (typeof ENV_KEYS)[number]

function findEnvFile(
  nodeProcess: NodeJS.Process,
  userDataDir: string,
  loadsProjectEnv: boolean
): string | null {
  const explicit = nodeProcess.env['FLOWLOOM_ENV_PATH']
  if (explicit && explicit.trim() && fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
    return explicit
  }
  const inUserData = path.join(userDataDir, '.env')
  if (fs.existsSync(inUserData) && fs.statSync(inUserData).isFile()) return inUserData
  if (loadsProjectEnv) {
    const inProject = path.join(nodeProcess.cwd(), '.env')
    if (fs.existsSync(inProject) && fs.statSync(inProject).isFile()) return inProject
  }
  return null
}

export function createEnvSource(
  nodeProcess: NodeJS.Process,
  userDataDir: string,
  loadsProjectEnv: boolean
): EnvSource {
  const envPath = findEnvFile(nodeProcess, userDataDir, loadsProjectEnv)
  return {
    getPath(): string | null {
      return envPath
    },
    read(): Record<string, string> {
      const effective: Record<string, string> = {}
      for (const key of ENV_KEYS) {
        const fromOs = nodeProcess.env[key]
        if (typeof fromOs === 'string' && fromOs.length > 0) effective[key] = fromOs
      }
      if (envPath) {
        try {
          const raw = fs.readFileSync(envPath, 'utf8')
          const parsed = parse(raw)
          for (const key of ENV_KEYS) {
            const value = parsed[key]
            if (typeof value === 'string' && value.length > 0) effective[key] = value
          }
        } catch (error) {
          // A readable-environment failure must never break app startup.
          console.warn(`[flowloom] .env file could not be read: ${String(error)}`)
        }
      }
      return effective
    }
  }
}
