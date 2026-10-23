# Flowloom — agent notes (Prompt 5 of 5 + Paper Instruments integration, complete)

Desktop workflow-automation app: Electron 45 + electron-vite 6, React 19, TypeScript,
Tailwind CSS 4 (CSS-first `@theme`), vitest, ESLint (flat). CommonJS build
(`out/main/index.js` is the Electron main entry).

## Commands

| Purpose | Command |
| --- | --- |
| Dev run | `npm run dev` |
| Production build | `npm run build` → `out/{main,preload,renderer}` |
| Typecheck | `npm run typecheck` (two programs: `tsconfig.node.json` = main+preload+shared+tests, `tsconfig.web.json` = renderer+shared+preload api) |
| Lint | `npm run lint` (flat ESLint; `no-explicit-any` on, `no-console` allows warn/error — `src/main/lib/log.ts` is exempt as the logging chokepoint) |
| Unit tests | `npm test` (vitest, 211 tests + 6 live tests skipped unless explicitly enabled) |
| Free live provider check | `npm run live:check` (read-only; no session, no audio, no generation, no credits) |
| Live browser ops | `npm run live:browser` (`FLOWLOOM_LIVE_BROWSER=1`; three real billable Browserbase sessions) |
| Live voice generation | `npm run live:voice` (`FLOWLOOM_LIVE_VOICE=1`; one short real ElevenLabs generation) |
| Live Paper Instruments check | `npm run live:paper` (`FLOWLOOM_LIVE_PAPER=1`; free unbilled GETs only — /v1/models, model lookup, /v1/usage). A bounded billable generation additionally requires `FLOWLOOM_LIVE_PAPER_GENERATION=1` |
| Electron smoke | `npm run build && npm run smoke` (wraps in `xvfb-run -a` on headless Linux; needs `node_modules/electron/dist` — run `node node_modules/electron/install.js` if it is missing; the Electron tree is killed as a process group to avoid stale single-instance locks) |

## Layout

- `src/shared/contracts.ts` — single typed contract surface (config view, test results, IPC channel names). Imported by main, preload, renderer.
- `src/main/` — config (`config/`: service, resolution rules, secrets vault via safeStorage), env loading (`env/`), providers (`providers/`, plain `fetch` + injectable fetch, real REST APIs), services (`connectionTests`, `workflows`, `runHistory`, `artifacts`, `narration.ts` — optional ElevenLabs run feedback, `execution/` — including the `browserbase.ts` REST session client, `browserRunner.ts` CDP runner, and `browserExecutor.ts` executor adapter), IPC (`ipc/register.ts`), logging (`lib/log.ts`, shared redactor), bootstrap (`index.ts`).
- `src/main/services/execution/` — the Prompt 3 run engine: `planner.ts` (main-process plan/validation boundary), `executors.ts` (explicit executor registry), `engine.ts` (run lifecycle, promise-graph scheduler, cancellation, event publishing). `src/main/services/runHistory.ts` persists runs under `<userData>/runs/` (one file per run + `index.json`).
- `src/preload/` — `api.ts` (types only), `index.ts` (contextBridge; only whitelisted channels).
- `src/renderer/src/` — React UI. `pages/` (editor, workflows, history, settings + `settings/` section modules), `components/` (ui primitives, shell, editor), `state/`, `lib/`.
- Workflow graph model: `src/shared/nodeSchema.ts` — the versioned graph types (`WorkflowGraph` v1), the node registry (trigger / browserAction / delay / condition / data / join / paperInstruments), zod config schemas, `validateWorkflowGraph` (structural vs config-issues), `checkNavigationUrl` (the browser URL-safety policy: http(s) only, no loopback/private/link-local/metadata hosts, no embedded credentials), and `explainConnection` (connection gate). Main, renderer, and tests share this file as the single source of truth. Each registry entry carries `executable: boolean` — all seven types are executable since Prompt 4. Browser actions may set an optional URL on *any* action: `navigate` requires it, the rest treat it as "navigate to this page first" (one node = one session = one navigation + operation; live-verified).
- Run-state model: `src/shared/runTypes.ts` — `RunStatus` (queued → validating → running → cancelling? → succeeded | failed | cancelled, terminal is final), `NodeRunStatus` (pending / running / succeeded / skipped / failed / cancelled), `RunRecord`, `RunSummary`, `RunEvent` (every event carries `runId` + `workflowId` so stale events can be ignored; node events may carry a real, redacted stage `message`). Node records may carry bounded `meta` — a union of `BrowserOperationMeta` (browser shape, has `operation`) and `PaperGenerationMeta` (paper shape, has `model`); discriminate with `'operation' in meta` / `'model' in meta`. Never fabricate either shape's fields.
- `tests/main/` — vitest unit tests (config precedence, secrets isolation, provider mocks, workflow store).
- `scripts/smoke.mjs` — boots the built app headlessly and asserts the boot line + 2.5 s survival.
- Electron security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP meta in `src/renderer/index.html`.

## Config model (do not break)

- Resolution: saved Settings override > `.env` > the one documented default (Ollama base URL
  → `http://127.0.0.1:11434`). Clearing an override re-exposes the `.env` value.
- `.env` lookup: `FLOWLOOM_ENV_PATH` > `<userData>/.env` > `<cwd>/.env` (for any unpackaged
  run — dev, preview, direct electron; packaged installs use `userData`/explicit path). The app never writes `.env`.
- Secrets (API keys) live encrypted (safeStorage) in `<userData>/secrets.json`; if safeStorage is
  unavailable they stay session-only. They are never sent to the renderer — only
  `configured`/`source` metadata, and never logged (values are redacted).
- App data: `<userData>` (`settings.json`, `secrets.json`). Workflows: one JSON file per
  workflow record + `index.json`.
- Provider tests run in the main process only; results (secret-free) persist per section in
  `settings.json` and are cleared when that section is saved.

## Conventions

- UI state colors: ok `#157f3d`, bad `#c22f3d`, warn `#a05a12`, accent `#3f4cc0`; dark rail `#17181c`.
- Lucide icons only; no emoji; honest empty states (no fake data, no invented model IDs).

## Workflow editor (Prompt 2)

- Library: `@xyflow/react` 12.12 (React Flow v12) — the only runtime dependency added.
- **The preload environment is dependency-free by law**: with `sandbox: true`, preload
  `require()` only allows Electron's tiny built-in list. Channel strings live in
  `src/shared/ipcChannels.ts`; never import contracts (or anything transitively using
  zod) from the preload. `scripts/smoke.mjs` enforces this on every build.
- Node registry (`nodeSchema.ts`) drives everything: card content, inspector fields,
  validation, persistence checks, and the connection gate. Add new node types there; the
  renderer maps ids to icons via `nodeDisplay.ts` and to cards via `nodeTypes.tsx`.
- Graph rules: acyclic; trigger emits only; condition has two outputs (`true`/`false`);
  join accepts unlimited inputs; self-connections, duplicate ids, dangling endpoints,
  unknown types, and wrong schema versions are structural (block saving). Missing
  per-node config fields are *config issues* — saved, flagged on the card and the
  toolbar (`N steps need setup`), never claimed runnable.
- Persistence: editor state persists (debounced, ~500 ms) through `saveWorkflow` IPC;
  the main process revalidates as authority and returns `WorkflowSaveResult`
  (errors vs saved-with-notes). Nodes/edges are stored verbatim in the workflow record
  (`<userData>/workflows/<id>.json`, schemaVersion 1). Duplicating a workflow clones
  the graph with a new id. Preferred delete/undo semantics: Delete/Backspace on focused
  canvas removes selection (input fields guarded); Ctrl/Cmd+Z / Ctrl+Shift+Z undo/redo.
- Run control: Run in the editor toolbar saves the dirty graph first (the engine executes
  what is persisted; failed saves refuse to run), then `startRun(workflowId)`. Validation
  errors from the engine surface in the editor toast as actionable messages. While a run is
  active the toolbar shows a live status chip and a Cancel button.

## Execution engine (Prompt 3)

- **Scheduling model** (`engine.ts`): one deferred promise per edge; a node's promise
  resolves when its source reaches a terminal state (succeeded-with-handle / skipped /
  failed). A node with incoming edges waits for all of them, except a join with `any`,
  which proceeds on the first success. Deterministic: independent branches run as
  concurrent promise chains; outputs are published per node id (`ctx.upstream`).
- **Branch/join semantics**: a condition evaluates real upstream data and resolves the
  taken handle's edge `succeeded`, the other `skipped`. A node whose incoming edges are
  *all* skipped is skipped and skips its own downstream — skips can never deadlock joins.
  Join `all`: wait for every input; any failure marks the node skipped (the run fails
  record the cause), all-skipped marks skipped; pass-through uses the first non-skipped
  success. Non-join nodes with multiple inputs use the same all-strategy. Join `any`:
  first success wins, other branches may fail or skip freely.
- **Execution correctness rules**: every persisted node type has an executor or is refused
  (`executable` flag); the engine refuses browser workflows *before side effects* when
  Browserbase credentials are missing (`credentialGate`, per-missing-field messages),
  and the planner refuses nodes
  unreachable from a trigger, disconnected triggers, missing triggers, incomplete
  configuration, cycles, and malformed graphs. Nothing is silently modified to make a run
  work. A run is succeeded only when the trigger ran and nothing failed.
- **Cancellation** is real: `cancel(runId)` flips the shared signal, fires delay
  listeners (timers cleared immediately), stops scheduling, marks pending nodes
  `cancelled`, and persists `cancelled` — never reported as success. The hard two-hour
  safety cap force-cancels with an explicit error.
- **Failure handling**: executor errors become node `failed` (node id, type, redacted
  message); downstream nodes are skipped; run terminal = failed with a node-attributed
  reason. First failure wins; downstream never runs. No retries exist yet (nothing is
  silently retried).
- **Data passing**: only node outputs flow between nodes. Text fields may contain
  `{{nodeId}}` references resolving against *already finished* steps (`resolveTemplate`
  in `nodeSchema.ts`); unresolved references fail the node with an actionable error,
  never an empty string. No eval/Function ever. Payload cap: 64 KB per resolved value
  (`MAX_TEMPLATE_PAYLOAD`).
- **Executors** (`executors.ts`): trigger (per-run metadata, race-free; no global
  mutable state), data (template-resolved static text — no model call), delay
  (`cancellableDelay`; real configured seconds, 1–3600, schema + executor bounds),
  condition (`evaluateCondition` — contains / doesNotContain / equals / notEquals /
  isEmpty / isNotEmpty; `operator` field defaults to `contains` so old saved configs keep
  their meaning; empty-string inputs are real values, not errors), join (pass-through of
  the first delivered branch output).
- **Concurrency limits**: `MAX_CONCURRENT_RUNS = 3` global; one run per workflow;
  duplicate requests rejected with a clear message. Every run has its own
  `RunContext`/signal — cancelled runs never corrupt newer ones.
- **Run history** (`runHistory.ts`): `<userData>/runs/<runId>.json` + `index.json`.
  Written at run start, per node transition, and terminal state — atomic temp+rename,
  serialized through an internal promise queue. `list()` newest-first, self-heals after
  missed trims. Retention: keep the Newest 200 (`RUN_HISTORY_LIMIT`); oldest files are
  removed *and their index entries go with them*; recent records are never silently
  dropped. Deleting a workflow never deletes its run history. Corrupted records read as
  missing, not as success.
- **Secrets**: run events and history carry statuses, timestamps, and redacted,
  size-capped output summaries (400 chars) only — the redactor scrubs known secret
  values; provider keys/config never enter outputs or the renderer.
- **Renderer integration**: `onRunEvent` subscription (unsub on unmount — no duplicate
  listeners), run events ignored for stale runIds, node cards wear the live
  `NodeRunStatus` as a restrained border + status dot, browser-action cards show real
  live stages ("Preparing session", "Navigating…", "Extracting…") published from the
  runner, and the `RunPanel` overlay shows
  real status/elapsed/node timeline with cancel + history links. `HistoryPage` lists and
  opens persisted runs (node-level detail view). Timers, tickers, and listeners are
  cleaned up; `motion-reduce` respected for spinning indicators.
- **App shutdown**: `before-quit` calls `narration.shutdown()` then `engine.shutdown()` —
  pending narration is dropped, active runs are recorded
  honestly as failed ("Flowloom closed while this run was executing"), never as finished.
- Module-relative import depths (renderer): from `src/renderer/src/*` dirs one level deep, shared
  contracts are 2 ups (`../../shared`); from `pages/` 3 ups; from `pages/settings/` and
  `components/<dir>/` 4 ups.

## Voice narration (Prompt 5)

- Optional and off by default; workflows never require ElevenLabs to run and provider
  errors never change a run's outcome. Generation happens only when enabled, only for
  real events, and only one request per announcement — no retries (credits are never
  spent twice on one event).
- **Narration service** (`src/main/services/narration.ts`): consumes the same typed
  `RunEvent` stream the renderer receives (wired in `index.ts` next to `publish`). It
  speaks: run started, succeeded, failed, cancelled — plus each finished/failed browser
  step (users wait on those) when `voice.narrationBrowser` is on. Messages are fixed
  templates + user-authored node titles (sanitized to 80 chars); never page content,
  error internals, or secrets. Runs are deduplicated per event key; a terminal run
  ignores all later (stale) events; generation is serialized through an internal queue;
  `shutdown()` (before-quit) drops the queue. Unconfigured ElevenLabs is logged
  throttled, never surfaced as a workflow error.
- **Generation** reuses the verified providers path (`elevenlabs.generateSpeech` =
  voice lookup + real `POST /v1/text-to-speech/{voiceId}`, mp3, ≥16-byte honest check).
  Audio is passed base64 to the renderer — never written to disk — via one new push
  channel `voice:narration`; preload adds `onNarration`.
- **Renderer** (`NarrationPlayer.tsx`, mounted once in `App`): single `Audio` element,
  arrival-order playback, dedupe by event key, playbackRate from `voice.narrationSpeed`
  (0.7–1.5), blob URLs always revoked. The RunPanel shows a mute toggle during active
  runs: it saves `voice.narrationEnabled=false` (future narration stops at the source,
  re-read per queued item) and raises an in-renderer mute event to stop the current
  playback immediately.
- **Settings** (`VoiceSection` → "Voice feedback during workflow runs"): enable toggle
  + per-category toggles (run started/completed, failures/cancellations, browser step
  finished) + playback-speed select; each change saves immediately and re-reads the
  real config. Test Voice remains the real generation check.
- **Narration config keys** (Settings-only, no env counterpart): `voice.narrationEnabled`
  (default false), `voice.narrationSuccesses` (default true), `voice.narrationIssues`
  (default true), `voice.narrationBrowser` (default true), `voice.narrationSpeed`
  (default 1, clamped 0.7–1.5). ElevenLabs credentials remain under the Prompt-1 names
  (`elevenlabsApiKey` secret, `voice.voiceId` override / `ELEVENLABS_VOICE_ID`).
- Tests: `tests/main/narration.test.ts` (mocked fetch; lifecycle order, dedupe,
  category filtering, stale-event drop, credential-missing skip, generation-failure
  tolerance, shutdown, secret-free texts) and narration-settings validation +
  persistence rounds in `configService.test.ts`.

## Live verification status (honest)

All live checks below were performed on Oct 23, 2026, from this machine, against the
credentials in `.env` (values never printed):

- **Browserbase — real sessions executed.** `tests/live/browserLive.test.ts` ran the
  exact production runner (`runBrowserOperation` + `createDefaultRunnerDeps`) three
  times against `https://example.com/`: a navigation (real final URL + title
  "Example Domain", ~11 s), a live screenshot stored as a managed artifact
  (`art_…`, real PNG bytes > 1 KB), and a real text extraction (917 characters).
  Every session was released in `finally` as designed. Zero secrets surfaced.
- **ElevenLabs — real audio generated.** `tests/live/voiceLive.test.ts` produced
  35 151 bytes of mp3 (~2.9 s) via `generateSpeech` with the configured voice ID —
  the same path the in-app Test Voice and the narration service use.
- **Paper Instruments — free endpoints and one live generation verified.**
  `npm run live:check` and `FLOWLOOM_LIVE_PAPER=1 npx vitest run
  tests/live/paperLive.test.ts` exercised the exact production provider module
  (`testPaperInstruments`) against the live API: `GET /v1/models` accepted the key,
  the configured model id (`ultramarine-1-flash`) exists for the account, and
  `GET /v1/usage` returned the real prepaid balance ($5.00 available, $0.00
  reserved). With explicit user approval the doubly-gated bounded generation ran
  once: `POST /v1/chat/completions` with `ultramarine-1-flash`, 128-token cap,
  `low` effort — real reply, `finish_reason=stop`, provider usage verbatim
  (19 prompt / 5 completion / 1 reasoning / 24 total tokens, 1.5 s). Nothing was
  estimated or faked; details in `progress.md`.
- Free checks (`npm run live:check`): Browserbase key accepted, ElevenLabs key
  accepted, voice ID present, Paper Instruments key/model/balance verified. No
  sessions, no audio, no generations, no credits.
- Electron production build boots headless and stays alive (smoke script).

## Live commands (explicit, user-initiated)

- `npm run live:check` — free read-only verification of all three providers (never bills).
- `npm run live:browser` — three real Browserbase sessions (nav / screenshot /
  extraction); runs `tests/live/browserLive.test.ts`, skipped unless
  `FLOWLOOM_LIVE_BROWSER=1` is set.
- `npm run live:voice` — one short real TTS generation; runs
  `tests/live/voiceLive.test.ts`, skipped unless `FLOWLOOM_LIVE_VOICE=1` is set.
- `npm run live:paper` — free Paper Instruments GETs (models / model / usage); runs
  `tests/live/paperLive.test.ts`, skipped unless `FLOWLOOM_LIVE_PAPER=1`. A bounded
  128-token billable generation needs the additional `FLOWLOOM_LIVE_PAPER_GENERATION=1`.

## Paper Instruments integration (Ultramarine API)

Verified upstream facts (docs, October 2026) live in
`src/main/providers/paperinstruments.ts` — consult it before touching the API
surface. Base URL `https://api.paperinstruments.com/v1`; OpenAI-compatible
`POST /v1/chat/completions` (`reasoning_effort` low|high|max, default **max**
upstream — Flowloom defaults its node config to `low` to keep one cost small;
`max_completion_tokens` includes reasoning; optional
`response_format: {"type":"json_object"}`; non-streaming here). Free endpoints:
`GET /v1/models`, `GET /v1/models/{id}`, `GET /v1/usage`
(`available_nanodollars`/`reserved_nanodollars`, 1 USD = 1e9 nanodollars).
Documented errors mapped in `mapPaperError`: 401 → auth; 403
billing_account_suspended → auth; 404 → model_not_found; 429 splits into
`insufficient_quota` → `insufficient_credit` vs rate/concurrency → rate_limit;
400 `invalid_value` with `param === 'model'` → model_not_found; 5xx → server_error.

- **Not implemented on purpose**: the document libraries (paper-docx / paper-pptx /
  paper-fsx / paper-xlsx) and `rubric` are Python-ecosystem-only, so they cannot be
  integrated here without misrepresenting or faking the documented interface. The
  integration scope is exactly the documented HTTP chat-completions surface.
- **Env/config names**: official key name `PAPERINSTRUMENTS_API_KEY` (`.env` / secret
  vault key `paperinstrumentsApiKey`); Flowloom-local `PAPERINSTRUMENTS_MODEL`
  (override `paper.model`). Precedence: Settings override > `.env`, same as every
  other section. A model id is REQUIRED — Flowloom never substitutes or guesses
  one (`DOCUMENTED_EXAMPLE_MODEL` is only ever a UI hint).
- **Settings section `paper`** (`PaperSection.tsx`): enable toggle (default ON; off =
  every paper step refuses before any request), API key (secure storage), model id,
  local spending stop `paper.minBalanceUsd` (0–100 USD, default 0 = check disabled).
  "Test connection" is FREE (three documented GETs and includes the real balance —
  never an invented figure); "Test generation" is billable, hard-bounded (128
  completion tokens, `low` effort), and runs only on an explicit press.
- **Node type `paperInstruments`** (`paperConfigSchema`): `name`, `model` (empty =
  Settings fallback), `system`, `prompt` (both accept `{{stepId}}` templates),
  `reasoningEffort` (default `low`), `maxOutputTokens` (64–8192, default 512),
  `responseSchema` (optional JSON string), `timeoutSeconds` (5–120, default 60).
- **Runner** (`paperRunner.ts`): one documented request; no retries of any
  non-idempotent call. Spending stop: when > 0 it first reads the free usage
  endpoint and refuses when the provider-reported balance is below it — and refuses
  *without figures invented* when the usage call fails. With stop = 0 the check is
  skipped entirely: the provider's own prepaid reservation (429
  `insufficient_quota`) remains the primary protection. `finish_reason === 'length'`
  is reported as a truncation warning, not a failure; output is clamped to
  `PAPER_OUTPUT_LIMIT` (64 000 chars). Structured mode (`json_object` +
  `validateJsonDocument`) enforces only an honest, documented JSON-Schema subset —
  type/const/enum, string bounds+pattern, numeric bounds, array
  items/bounds, object properties/required/additionalProperties:false; unknown
  schema keywords are ignored by design (documented as a subset, not full
  JSON-Schema). The validated JSON document is what flows downstream.
- **Metadata**: `PaperGenerationMeta` records the model, finishReason,
  structured flag, and the provider's OWN usage numbers verbatim (prompt /
  completion / reasoning / total tokens) — never estimates — plus the balance
  the provider reported before the call when it was checked.
- **Wiring**: `setPaperExecutor` in `main/index.ts`; `credentialGate` checks
  browser and paper prerequisites per node (enable, key, per-node model fallback).
- Tests: `tests/main/paper.test.ts` (provider module, error mapping, free test,
  settings precedence/lastTest clearing) and `tests/main/paperRunner.test.ts`
  (spending-stop refusal before any request, structured-output subset,
  executor refusals, engine end-to-end with mock fetch). The default suite never
  sends a billable request.
