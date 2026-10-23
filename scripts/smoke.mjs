#!/usr/bin/env node
/**
 * Electron smoke test: launches the production build and verifies the
 * main process reaches "Starting Flowloom" and stays alive (window
 * created + ready-to-show path) for a moment without crashing.
 *
 * Requires the app to be built first (`npm run build`). On Linux
 * headless machines the run is wrapped in xvfb-run automatically.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'out', 'main', 'index.js')

if (!existsSync(entry)) {
  console.error('smoke: out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

/* The preload bridge runs with sandbox:true, where require() can only
   load a tiny built-in allowlist. Any other bare require (e.g. zod
   sneaking in through a shared module) crashes the preload and kills
   the whole bridge — the renderer would show "bridge unavailable". */
const preloadPath = path.join(root, 'out', 'preload', 'index.js')
if (existsSync(preloadPath)) {
  const preloadSource = readFileSync(preloadPath, 'utf8')
  const requires = [...preloadSource.matchAll(/require\(\s*["']([^"'.][^"']*)["']\s*\)/g)]
  const shimmable = new Set(['electron', 'events', 'timers', 'url', 'node:electron', 'node:events', 'node:timers', 'node:url'])
  const offenders = requires.map((match) => match[1]).filter((name) => !shimmable.has(name))
  if (offenders.length > 0) {
    console.error(
      `smoke: the preload bundle requires modules unavailable under sandbox:true (${[...new Set(offenders)].join(', ')}). ` +
        'Keep the preload dependency-free (channel strings live in src/shared/ipcChannels.ts).'
    )
    process.exit(1)
  }
}

const isLinux = process.platform === 'linux'
const hasDisplay = Boolean(process.env.DISPLAY) || Boolean(process.env.WAYLAND_DISPLAY)
const needsXvfb = isLinux && !hasDisplay && !process.env.FLOWLOOM_SMOKE_NO_XVFB

const electronArgs = [path.join(root, 'node_modules', '.bin', 'electron'), entry]
const command = needsXvfb ? 'xvfb-run' : electronArgs[0]
const args = needsXvfb ? ['-a', ...electronArgs] : electronArgs.slice(1)

const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' },
  // Own process group: xvfb-run leaves the Electron tree as its children and
  // a surviving instance holds the app's single-instance lock, making every
  // later run exit silently with code 0 before the boot line.
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe']
})

function killTree() {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

let buffer = ''
let sawBootLine = false
let failure = null

const BOOT_PATTERN = /Starting Flowloom/
const CRASH_PATTERN = /(Uncaught Exception|Cannot find module|ERR_MODULE_NOT_FOUND|FATAL:)/

function fail(reason) {
  if (failure) return
  failure = reason
  killTree()
}

const timeout = delay(45_000).then(() => {
  fail('timeout: the boot line never appeared within 45 seconds.')
})

child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
})
child.stderr.on('data', (chunk) => {
  buffer += String(chunk)
})

await delay(300)
while (!failure) {
  if (!sawBootLine && CRASH_PATTERN.test(buffer)) {
    fail(`main process crashed during startup:\n${buffer.slice(0, 4000)}`)
    break
  }
  if (!sawBootLine && BOOT_PATTERN.test(buffer)) {
    sawBootLine = true
    // Keep it alive a moment: an immediate exit after the boot line means
    // the window creation or renderer load failed.
    await delay(2500)
    if (!failure && child.exitCode === null) {
      console.log(`smoke: boot line observed; process stayed alive for 2.5s.\n${buffer.split('\n')[0]}`)
    } else if (!failure) {
      fail(`main process exited right after boot (code ${child.exitCode})`)
    }
    fail('smoke complete') // reuse the failure channel to stop the loop
    break
  }
  if (child.exitCode !== null) {
    fail(`main process exited before the boot line appeared (code ${child.exitCode}):\n${buffer.slice(0, 4000)}`)
    break
  }
  await delay(250)
}

if (failure && failure !== 'smoke complete') {
  console.error(`smoke: FAILED — ${failure}`)
  process.exit(1)
}
killTree()
process.exit(0)
