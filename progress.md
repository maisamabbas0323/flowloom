# Prompt 1 progress — verified state

Date: 2026-10-21. Report scope: Prompt 1 of the Flowloom build plan.

## What was built

Full Prompt-1 implementation: the app shell with editor / workflows / history / settings
routes, the secure settings surface (language engine, voice, browser, general), real
provider connection tests in the main process, and the honest empty-state discipline
(no fake data, no invented model IDs, no AI branding, Lucide icons only).

### Verified results (all commands re-run this session)

| Check | Result |
| --- | --- |
| `npm run typecheck` (node + web programs) | **pass**, zero errors |
| `npm run lint` | **pass**, zero errors / zero warnings |
| `npm test` (vitest) | **pass**, 49/49 in 4 files |
| `npm run build` | **pass** (out/main 65.9 kB, out/preload 1.7 kB, renderer bundle built) |
| `npm run smoke` (headless xvfb) | **pass** — boot line observed, process stayed alive 2.5 s after window creation |

### Test coverage (tests/main/)

- `configService.test.ts` — precedence (Settings > .env > default), clear-override
  re-exposure, Ollama default URL, invalid provider/URL rejection, cross-section
  isolation on save, secrets never serialized into the renderer view (settings or
  env-sourced), main-process-only secret reads, restart persistence through the
  encrypted vault file, session-only vault fallback when safeStorage is unavailable,
  `.env` write-neutrality, log redaction, test-outcome clearing on section save.
- `providers.test.ts` — Google (auth/model_not_found/timeout/network), OpenRouter
  (bearer header, 401→auth, 404→model_not_found), Ollama (exact-tag matching, wrong-tag
  refusal, optional key header, invalid base URL without network call),
  ElevenLabs (xi-api-key header, unknown voice ID → voice_not_found, real audio bytes
  returned on success), Browserbase (create+close flow, project-ID → invalid_target,
  close failure → cleanup_warning, 401→auth).
- `connectionTester.test.ts` — no fetch before required fields exist (model, voice,
  browser), provider/model/key never switched behind the user's back, outcome
  persistence for success and failure, duplicate concurrent test refusal.
- `workflows.test.ts` — record CRUD against real files, createdAt/updatedAt semantics,
  path-like id rejection, unknown-id nulls.

### Fixed while verifying

- Workflow service: generated `wf_…` ids did not pass its own id validation regex
  (underscore missing) — every real create would have thrown; `save()` now validates
  the id up front instead of swallowing it into a silent null.
- Renderer module paths (several files pointed one directory too high/low) and
  `tsconfig.web.json` include (preload moved from `index.d.ts` to `api.ts`).
- CanvasViewport drag-to-pan handlers were written but not wired to the DOM — now
  attached (wheel-zoom + pointer-drag pan work).
- Browserbase test result construction (definite-assignment issues), unused imports,
  an unused interface, non-warn/error console call outside the logger.

## Conflict with the honest-failure spec — resolution

The spec's failure codes and messaging remain intact (unconfigured / auth /
model_not_found / voice_not_found / invalid_target / server_unreachable / rate_limit /
server_error / timeout / cleanup_warning). No check was weakened to make tests pass.

## Smoke test lifecycle

- The `electron` package's binary (`node_modules/electron/dist`) was never materialized
  by npm postinstall. The GitHub releases CDN and npmmirror throttled single-stream
  (and even 16-connection) downloads to ~0–5 KB/s with stalls; **mirrors.huaweicloud.com**
  served it reliably (~300+ KB/s). Downloaded via aria2c with 16 connections,
  SHA-256 verified against `node_modules/electron/checksums.json`
  (`22f6a10b…c3e3a`), and unpacked into `node_modules/electron/dist` manually.
- The official `install.js` stalled on its cache check and the `.bin/electron` CLI
  shim requires `node_modules/electron/path.txt` (the installer's marker file),
  so that marker was created by hand. `electron --version` → `v45.0.0`.
- `scripts/smoke.mjs` launches the built `out/main/index.js` under `xvfb-run -a`,
  asserts the `Starting Flowloom` boot line, and confirms the process stays alive
  for 2.5 s after window creation. **Result: pass** —
  `[flowloom] Starting Flowloom 45.0.0 (linux) — no .env file found`.

## Honest limits — what is NOT yet verified

- **No live provider calls.** No real Google / OpenRouter / Ollama / ElevenLabs /
  Browserbase credentials exist in this environment. All provider paths are verified
  only via controlled mock HTTP responses in tests and the mocked ConnectionTester.
  First real-world smoke against actual services is explicitly left for a later phase.
- **No integrated real-key connection test in the running app** (same credential gap).
- Voice playback path (`Blob` + `createObjectURL` + `<audio>`) is wired but only
  exercised with mock audio bytes.
- History is a truthful "no runs yet" state.

## Prompt 2 — verified results 2026-10-22

All commands run green in sequence (`typecheck` → `lint` → `test` → `build` → `smoke`).

- **What works**
  - Real visual workflow editor on `@xyflow/react` 12.12: dotted-grid canvas, drag-to-move,
    drag-drop and click-to-add from the node library, panning, zoom via bottom-left controls
    (25%–250%), fit-to-view.
  - Six node types with per-type cards, handles, and inspector fields: trigger (manual),
    browser action (navigate/extractText/click/fillField), delay (1–3600 s), condition
    (two curated branch outputs `Matches`/`Otherwise`), data/text, wait-for-connections
    (all/any). Multiple instances of every type are supported.
  - Structural edits that succeed persist automatically (~500 ms debounce; drag end and
    connect persist sooner). The toolbar mirrors dirty state; Save persists immediately.
    Unmount flushes a pending save, so switching routes/app close cannot drop a keystroke.
  - Undo/redo (Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y) with 700 ms type-burst coalescing; drag
    snapshots are taken at drag start so a moved node can be un-moved.
  - Delete/Backspace removes the selection on the focused canvas (guarded against text
    fields); Escape closes the library, then deselects.
  - Node inspects + delete with confirm; deleting a node cascades its edges (both in the
    renderer and enforced by validation on save).
  - Workflows page: create (from rail/toolbar), open, rename via editor name field,
    duplicate (`workflows:duplicate` IPC), delete with confirm, sorted by last update.
- **What is persisted**: workflow records with versioned graph (`schemaVersion: 1`),
  node ids/types/positions/configs and edges (incl. condition `sourceHandle`), **plus the
  canvas view (`view: {zoom, x, y}`)** — so reopening a workflow shows the exact same
  layout and the exact same zoom/pan the user left, not a re-fitted approximation. View
  changes from pan/zoom save silently after ~450 ms; a nonsensical view payload is
  rejected by the main process rather than stored. Verified by tests. Users' work also
  survives switching navigation pages (unmount flush) and app restarts.
  Workflows live in `<userData>/workflows/<id>.json` + `index.json`. Duplicating a
  workflow clones the graph with a new id. Preferred delete/undo semantics:
- **Validation semantics (verified by tests)**: structural failures block saving — wrong
  schema version, duplicate node/edge ids, dangling endpoints, self-connections, directed
  cycles, unsupported types, bad handle ids, non-input-capable targets, malformed entries.
  Incomplete configuration (empty name/URL/selector/value/checkText/contains) saves with
  per-node "setup needed" issues surfaced on cards, toolbar, and the saved toast.
- **Run control**: disabled everywhere with an explicit explanation; every saved toast says
  execution support is not available yet. No fake runs, no fake logs.
- **Settings fully intact**: same config service, secrets vault, env precedence, connection
  tests, and whitelisted IPC; the editor never requires provider credentials.
- Prompt-1 fixes folded in per user request: settings inputs unified and enlarged (shared
  field styles incl. the previously unstyled SecretInput), "Model ID" wording → "Model
  name (as installed)" for Ollama, About "i" icon removed from the nav rail (brand mark
  now returns to the editor; InfoModal deleted).
- **Electron smoke**: pass — boot line + 2.5 s survival, **and the real `.env` is now
  detected** (`[flowloom] Starting Flowloom 45.0.0 (linux) — .env loaded from …/.env`).
  Note: a surviving Electron instance holds `requestSingleInstanceLock` and makes later
  smoke runs exit silently with code 0; `scripts/smoke.mjs` now spawns detached and kills
  the whole process group, which fixes that class of failure at the source.
- **Post-ship fix (2026-10-22): "Flowloom bridge unavailable".** The Prompt-2 contracts
  change pulled `zod` into the preload bundle (`import { IPC } from '…/contracts'`), and
  with `sandbox: true` preload may only require a Electron built-in allowlist — the
  preload crashed and the bridge never mounted. Fixed by moving the channel names into a
  dependency-free `src/shared/ipcChannels.ts` (contracts re-exports them; preload imports
  that file directly) and dropping the value re-exports of `nodeSchema` from contracts.
  `scripts/smoke.mjs` now fails the build if the preload bundle contains any bare
  `require()` outside Electron's sandbox allowlist, so this cannot recur silently.
- **`.env` in a production-ish run**: previously a project-root `.env` was only honored
  during `electron-vite dev`; unpackaged runs now honor it too (packaged installs use
  `userData/.env` or `FLOWLOOM_ENV_PATH` as before).
- **New runtime dep**: `@xyflow/react` 12.12 (the only addition; no second config system).

## Honest limits (Prompt 2 additions) — what is NOT yet verified

- **No manual visual interaction was performed** (there is no interactive display in this
  environment) — the smoke covers boot + window survival only; canvas gestures were
  verified at the data/logic level through the registry and service tests.
- Browser steps never create sessions or act on web pages yet; delay does not wait;
  condition does not branch; join does not coordinate. All of that is Prompt 3
  (workflow execution engine) and Prompt 4 (Browserbase + model integration).

## Prompt 3 — verified results 2026-10-22

All commands run green in sequence (`typecheck` → `lint` → `test` → `build` → `smoke`).
**110/110 tests pass** (vitest, 7 files), lint zero problems, production build succeeds,
smoke boots the real app with `.env` detected and the preload-dependency guard passing.

- **Run is real.** Pressing Run in the editor saves the dirty graph first (the engine
  executes exactly what is persisted; a failed save refuses to start a run), then calls
  `runs:start` → main-process `ExecutionEngine.start(workflowId)`. The engine
  independently re-validates the persisted record (structural + config completeness +
  trigger connectivity + reachability + unsupported types) and refuses with actionable,
  per-node errors before any side effects. Duplicate concurrent runs of one workflow and
  runs beyond the 3-run global cap are rejected with honest messages; everything refused
  leaves no history entry.
- **Executed node types (real implementations, tested):** manual trigger (per-run
  metadata; concurrent runs cannot read each other's outputs), data/text
  (template-resolved static value — reference `{{nodeId}}` resolves upstream *outputs*
  only; no eval/Function; unresolved references fail with the list of known step ids;
  64 KB payload cap), delay (real configured 1–3600 s wait on a cancellable timer;
  verified ≥ the configured duration; cancel clears the timer immediately), condition
  (deterministic evaluation of actual upstream data through six operators: contains,
  doesNotContain, equals, notEquals, isEmpty, isNotEmpty — new `operator` field defaults
  to `contains`, so Prompt-2 saved configs keep their exact meaning), join (both
  behaviors tested).
- **Branching verified by tests:** conditions select the real branch; the unselected
  branch skips (never fake-succeeds); skipped branches skip downstream; join `all` waits
  for every input and proceeds past legitimately skipped branches without deadlocking;
  join `any` proceeds on the first delivered success and treats real failures honestly.
- **Cancellation verified:** a run cancelled mid-delay ends `cancelled` (terminal,
  never rewritten to `succeeded`), the in-flight timer is freed immediately, pending
  nodes report `cancelled`, `cancelRequestedAt` persists, memory has no leaked timers.
- **Failures verified:** a bad reference fails its node with a safe message, downstream
  nodes are skipped, the run records `failed` with a node-attributed reason —
  downstream-on-failure never runs, and nothing can turn a failed/cancelled run into
  `succeeded`.
- **Run history verified:** persisted under `<userData>/runs/` (one JSON per run +
  index), written incrementally during execution, atomic temp+rename writes serialized
  through an internal queue, newest-first list, retention keeps the newest 200 and never
  silently drops recent records, corrupted files read as *missing* (not success), and
  runs survive workflow deletion (workflow name is snapshotted into the record).
- **Renderer verified at the logic level:** live run status chip + Cancel in the toolbar,
  node cards wear real engine statuses (running/succeeded/skipped/failed/cancelled), a
  RunPanel overlay shows actual elapsed time and a node timeline (no fake progress
  bars/percentages), history page lists and opens real persisted runs with per-node
  start/finish/duration/output summaries. Editor subscriptions clean up on unmount;
  stale runIds are ignored; a still-running run is re-adopted when the editor reopens.
- **Security boundaries kept:** secrets never reach the renderer; outputs/errors in
  history are redacted (known secret values scrubbed) and size-capped; every execution
  request is validated in the main process; no arbitrary code execution exists anywhere
  (explicit typed executors only); no shell, no eval; no model/API calls for the
  deterministic node types (none of the supported nodes needs credentials; `.env`
  config untouched and never printed).
- **New/changed files.** Shared: `nodeSchema.ts` (condition operators + `executable`
  registry flag + safe reference templating `resolveTemplate`/`hasValidReferenceSyntax`
  + payload cap), `runTypes.ts` (run/node states, RunRecord, RunEvent, RunStartResult),
  `ipcChannels.ts` (`runs:start`, `runs:cancel`, `runs:list`, `runs:get`, push channel
  `runs:event`). Main: `services/execution/planner.ts`, `engine.ts`, `executors.ts`,
  `services/runHistory.ts`, `ipc/register.ts` (4 new handlers, validated), `index.ts`
  (engine wiring, event fan-out to open windows, `before-quit` shutdown). Preload:
  `startRun`/`cancelRun`/`listRuns`/`getRun`/`onRunEvent` (returns an unsubscribe so
  mounts never duplicate listeners). Renderer: EditorPage run state + save-before-run,
  EditorTopBar real Run/Cancel/status chip, `nodeTypes.tsx` run-status dressings,
  new `RunPanel.tsx`, HistoryPage rewritten to real runs. Tests: `execution.test.ts`
  (planner + operators + templating + delay bounds/cancel), `engine.test.ts`
  (end-to-end real runs against the real stores: success, durations, branching, joins,
  failure propagation, cancellation, duplicate-run prevention, concurrency cap,
  history + workflow-deletion independence), `runHistory.test.ts` (persistence round
  trip, incremental updates, newest-first, corruption safety, retention, id safety,
  orphan awareness).

## Honest limits (Prompt 3 additions) — what is NOT yet implemented

- **Browser actions are explicitly non-executable** (Prompt 4): a workflow containing
  one is refused before any side effects with a clear explanation; no browser session is
  ever created just to prove the engine works.
- **ElevenLabs narration is not part of this phase** (Prompt 5 builds the voice layer).
- **No model-powered node exists yet.** When one arrives it must be a new registry entry,
  never inferred from a data/text node.
- **No automatic retries** (nothing retried silently; explicit policy to come with
  networked executors), and **no anti-fraud run-resume** — an app close mid-run records
  the run honestly as failed ("Flowloom closed while this run was executing").

## Prompt 4 — verified results 2026-10-22

All commands run green in sequence (`typecheck` → `lint` → `test` → `build` → `smoke`).
**150/150 tests pass** (vitest), lint zero problems, production build succeeds, smoke
boots the real app headlessly. Per the sequence order used this session:
`typecheck` pass → `lint` pass → `vitest` 150/150 pass → `npm run build` pass →
`npm run smoke` pass (exit codes observed for build and smoke; vitest output confirmed
no failing suites).

### What was built (real, not mocked)

- **Browserbase session client** (`src/main/services/execution/browserbase.ts`): REST
  `POST /v1/sessions` (with `project_id`, `timeout_seconds`, `REQUEST_RELEASE` on
  release) over injectable fetch; `GET /v1/sessions/:id` used by the existing Settings
  connection test. Result types: created / auth / invalid_project / rate_limit /
  network — mapped to honest `FailureCode` messages. The API key is sent only in the
  `X-BB-API-Key` header inside the main process and is redactable everywhere.
- **Session lifecycle**: one short-lived Browserbase session per browser-action
  execution; connect over CDP with `playwright-core` `connectOverCDP` using the
  API-provided `connectUrl` (never logged — it carries the session credential;
  `describeBrowserError` scrubs wss:// endpoints from any surfaced error). Cleanup
  always runs in a `finally`: browser disconnect, then REST `REQUEST_RELEASE`; a 404
  release means the session already ended, `unconfirmed` is surfaced as a warning.
  Cancellation closes the CDP connection immediately (unblocking pending waits).
- **Browser Action node** (`browserAction`, Prompt-2 type extended compatibly):
  operations `navigate`, `extractPageText`, `extractText`, `click`, `fillField`,
  `waitFor`, `pageInfo` (URL + title), `screenshot`. Inspector shows only
  operation-relevant fields (name, action, URL, selector, value, timeout,
  extraction limit, full-page toggle) with per-operation validation; card summary
  states the actual intent (Navigate to X / Extract selector Y / …).
- **Executor adapter** (`browserExecutor.ts`): validates and resolves `{{nodeId}}`
  references in URL/fill-value fields against finished upstream outputs only (same
  `resolveTemplate` rules as Prompt 3, no eval/Function/second templating system);
  revalidates the resolved URL immediately before navigation. Output: extract
  operations pass the real extracted text (truthfully empty when the page is empty);
  others pass the final URL; bounded by the extraction limit / 64 KB payload cap.
  Node `meta` records bounded browser metadata (operation, finalUrl, pageTitle,
  textChars, truncated, screenshotId, sessionId, durationMs).
- **URL safety** (`checkNavigationUrl` in `nodeSchema.ts`): http/https only; rejects
  `javascript:`/`file:`/`data:`/etc.; blocks loopback, private/link-local RFC1918 /
  169.254.x (incl. cloud metadata), and treats embedded userinfo as unsafe. Applied
  to the configured URL and re-applied after navigation (redirect destination
  re-check). Honest limitation documented: the remote browser's network path cannot
  be fully controlled by Flowloom, so this is a strong default policy, not complete
  SSRF protection.
- **Failure honesty**: selector timeout → "element not found within Ns"; navigation
  timeout → explicit timeout error; auth/rate-limit/session-creation failures mapped
  to clear messages; any executor failure fails the node and the run per Prompt-3
  semantics (downstream skipped). No fabricated success paths exist.
- **Cancellation**: cancellation closes the CDP browser (pending waits reject —
  verified the pending-wait listener is cleared); a stray late CDP resolution cannot
  rewrite a cancelled run (terminal state is final). Session cleanup still releases.
- **Artifacts** (`src/main/services/artifacts.ts`): screenshots are stored under
  `<userData>/artifacts/` with generated `art_<24 hex>` ids, size-capped, revealed
  through a single validated IPC channel (`artifacts:get`) returning safe base64 —
  the renderer never sees a filesystem path; missing artifacts degrade gracefully.
  Run history stores only the artifact id (no base64 in workflow graphs or run JSON).
- **Engine integration**: `browserAction` executor registered and `executable: true`;
  planner refuses workflows whose browser steps are unfinished, and the run is
  refused before side effects when Browserbase credentials are missing (credential
  gate in the engine), with the refusal surfaced in the editor toast. Condition
  nodes consume actual browser extraction via the upstream mechanism.
- **Renderer**: real stage messages flow through node events (`Preparing browser
  session…`, `Navigating to …`, `Extracted N characters`, `Screenshot captured` —
  only stages that correspond to actual operations, redacted); history detail view
  shows browser metadata and opens saved screenshots via the artifact channel;
  Settings' Browserbase section unchanged (same config service and precedence).

### New/changed files

Shared: `nodeSchema.ts` (browser-action schema v2 fields + URL policy), `runTypes.ts`
(node stage messages, node `meta`). Main: `execution/browserbase.ts`,
`execution/browserRunner.ts`, `execution/browserExecutor.ts`, `services/artifacts.ts`,
planner/executors/engine credential gate + stage publishing, `ipc/register.ts` +
`ipcChannels.ts` + preload (`artifacts:get`, `setBrowserExecutor` injection point),
`index.ts` (wiring). Renderer: `NodeInspector.tsx` (browser fields + validation),
`nodeTypes.tsx` (card summaries), `EditorPage.tsx`, `RunPanel.tsx`, `HistoryPage.tsx`
(browser detail + screenshot viewer). Tests: new `browserExecutor.test.ts` and
`browserRunner.test.ts`; engine/execution suites extended.

### Tests actually run (mocked, deterministic — no paid sessions)

browserExecutor/browserRunner suites: navigation + real metadata + session release;
truthful empty extraction; selector timeout → not-found failure; unsafe-URL refusal
before any session creation; auth / rate-limit failures; screenshot stored as managed
artifact; missing credentials refused; downstream output passing (Landed on
{{b}}); end-to-end Trigger → Browser → Condition; browser failure fails run and skips
downstream; unconfigured refusal before side effects; condition on empty output;
cancel mid-wait (prompt cancel + release); late resolution cannot un-cancel;
no credential material in events/history. Engine suites: planner accepts configured
browser steps and refuses unfinished ones.

## Honest limits (Prompt 4 additions)

- **No live Browserbase session was executed in this environment.** The integration is
  verified through controlled fake CDP/REST behavior in tests (same code paths as
  production; credentials resolved through the real resolver shape). A live
  navigate/screenshot check against the user's real Browserbase credentials remains an
  explicitly user-initiated follow-up.
- The Settings connection test performs a real, read-only `GET /v1/sessions` with the
  configured API key — no session is created and no credits are spent; the project ID
  is verified at run time by the API when sessions are created.
- URL policy is enforced client-side in Flowloom plus a redirect re-check; the remote
  browser's network boundary itself cannot be fully controlled from Flowloom.
- No retries exist for any browser operation (clicks/fills are externally consequential
  and are deliberately not retried).

## Next phase — Prompt 5

- ElevenLabs voice feedback (narration node + voice settings already stubbed in
  Prompt 1's settings surface).
- Final integration and product polish; first live-provider smoke with the user's .env.

## Prompt 5 — voice narration, final integration (Oct 23, 2026)

### Implemented (real behavior, no simulated results)

- **Narration service** (`src/main/services/narration.ts`): reads the same engine event
  stream the renderer gets; speaks run started / succeeded / failed / cancelled and
  optionally each finished or failed browser step. Fixed safe message templates +
  sanitized node titles only; per-event dedupe; terminal runs swallow stale events;
  serialized queue; shutdown drops pending announcements; failure-only-throttled logging;
  no automatic retries (one ElevenLabs request per announcement, credits protected).
- **Generation**: `elevenlabs.generateSpeech` (real voice lookup + `POST /v1/text-to-speech/{voiceId}`,
  mp3, honest ≥16-byte check). Audio goes base64 → push channel `voice:narration` →
  renderer playback; nothing written to disk; keys never leave the main process.
- **Renderer**: `NarrationPlayer` (single Audio element, ordered playback, event-key
  dedupe, playbackRate from settings, blob-URL cleanup) mounted at the app root;
  RunPanel mute toggle during active runs stops playback instantly and disables future
  generation at the source; VoiceSection gains narration enable/category toggles and a
  playback-speed select, each saving immediately through the real config service.
- **Config**: `voice.narrationEnabled` (default off), `voice.narrationSuccesses`,
  `voice.narrationIssues`, `voice.narrationBrowser` (defaults on), `voice.narrationSpeed`
  (1, clamped 0.7–1.5) — Settings-only keys, validated in `parseVoiceInput`, persisted in
  `settings.json`, exposed through `describe()`.
- **Browserbase connection test rewritten** to a real read-only `GET /v1/sessions`
  (no session is created and no credits are spent by the Settings test; a 401/403 is
  reported as auth failure, 429 as rate limit, 200 as success).

### Tests actually run (deterministic mocks only)

10 narration unit tests (lifecycle order, category filtering, dedupe, stale-event drop,
unconfigured skip, provider-failure tolerance, shutdown, secret-free texts), 6
rewritten Browserbase connection-test tests (GET-only verification, no POST/DELETE,
malformed project id refused without network, auth/rate/server mapping), narration-settings
validation + disk round-trip in configService tests. Suite total: 163 tests / 10 files,
all passing.

### Live verification actually performed

- Browserbase: real `GET /v1/sessions` with the user's configured key — HTTP 200
  (read-only; no session created, no credits spent).
- ElevenLabs: real `GET /v1/user/subscription` — HTTP 200; the configured
  `ELEVENLABS_VOICE_ID` verified to exist in the account via `GET /v1/voices/{id}` —
  HTTP 200. No audio was generated (that costs credits).
- Electron production build boots headlessly and stays alive (smoke script, 2.5 s).
### Honest limits

- URL policy is enforced client-side in Flowloom plus a redirect re-check; the remote
  browser's network boundary itself cannot be fully controlled from Flowloom.
- No retries exist for any browser operation (clicks/fills are externally consequential
  and are deliberately not retried).

## Key files for Prompt 4

- `src/main/services/execution/browserbase.ts` / `browserRunner.ts` /
  `browserExecutor.ts` — session client, CDP runner, executor adapter.
- `src/main/services/artifacts.ts` — screenshot artifact storage + IPC.
- `src/shared/nodeSchema.ts` — browser-action config schema and `checkNavigationUrl`.
- `tests/main/browserExecutor.test.ts`, `tests/main/browserRunner.test.ts` — mocked
  integration coverage.

## Oct 23, 2026 — real corrections and live verification (user-approved)

### Real bug found by the live audit and fixed

- **Extraction (and click/fill/wait/info/screenshot) could never see a real page.**
  Each browser action owns its own fresh session (`about:blank`), the inspector only
  showed a URL for `navigate`, and the runner ignored `config.url` for every other
  action — so the flagship "navigate, then extract" flow could not work in production.
  **Fix:** every browser action now accepts an optional destination URL ("navigate to
  this page first: one node = one session = one navigation + operation"). `navigate`
  still *requires* its URL. The optional URL passes through the same
  `checkNavigationUrl` safety gate and the same redirect re-check. Inspector labels
  ("URL (optional — navigate first)"), card summaries, and the runner (navigate-before-
  operation) all agree now. Not covered: two-node navigate→extract flows still cost
  two sessions by design (documented behavior).

### Second real bug fixed

- Saving narration-only preferences (e.g. the RunPanel mute toggle) cleared the
  persisted voice connection-test record from Settings. `saveVoice` now invalidates the
  stored test only when `apiKey`/`voiceId` actually change (regression test added).

### New live verification commands (explicit, user-initiated)

- `npm run live:check` — free read-only check of both providers (`scripts/live-check.mjs`).
- `npm run live:browser` → `tests/live/browserLive.test.ts` (3 real billable sessions;
  skipped unless `FLOWLOOM_LIVE_BROWSER=1`).
- `npm run live:voice` → `tests/live/voiceLive.test.ts` (1 real TTS generation;
  skipped unless `FLOWLOOM_LIVE_VOICE=1`).

### Live results actually observed (same day, user-approved credit spend)

- Free check: Browserbase key accepted; ElevenLabs key accepted; voice ID present.
- **Live browser (3 real sessions, exact production code path):**
  - navigate `https://example.com/` → final URL `https://example.com/`, title
    "Example Domain" (~11 s), session released.
  - screenshot of the live page → artifact `art_93e12489be8b0d220687eeb1`, real PNG
    bytes > 1 KB stored in an application-managed store (~16 s), session released.
  - extractPageText of the live page → **917 real characters** extracted
    (~10 s), session released.
- **Live ElevenLabs:** 35 151 bytes of real mp3 (~2.9 s) generated with the configured
  voice ID — the identical `generateSpeech` path used by Test Voice and narration.
- Full gate after the fixes: typecheck (both programs), lint, 166 tests passing
  (+4 live tests correctly skipped), production build, headless Electron smoke — all green.

### Remaining limits (truthful)

- The in-app Run button on a full saved workflow was not clicked in this environment
  (no display); the identical engine + runner path was verified live from the CLI, and
  the app itself was verified to boot with the real `.env`.
- Narration *playback* was not exercised headless (renderer `Audio` needs a display);
  generation (the credit-consuming, network part) was live-verified, and the player
  logic is unit-exercised. Test Voice in Settings performs the real end-to-end check
  when the user clicks it.
- Narration texts are English fixed templates; extracted page content is never spoken
  by design.

## Oct 23, 2026 — Paper Instruments (Ultramarine API) integration

Integrated the "Paper Instruments" text-model provider as a first-class Flowloom
integration, strictly scoped to the provider's documented HTTP surface
(`src/main/providers/paperinstruments.ts` carries every verified API fact).

### Implemented features (real, no simulated results)

- **Settings section `paper`** (`src/renderer/src/pages/settings/PaperSection.tsx`):
  enable toggle (default ON; OFF = every Paper Instruments step refuses before any
  request), API key (protected secure storage; env name `PAPERINSTRUMENTS_API_KEY`),
  model ID field (`PAPERINSTRUMENTS_MODEL` in `.env`, override `paper.model`;
  precedence Settings > .env, clearing an override re-exposes `.env`), and a local
  spending stop (`paper.minBalanceUsd`, 0–100 USD, default 0 = check disabled).
  "Test connection" is FREE by design — the three documented unbilled GETs
  (`GET /v1/models`, `GET /v1/models/{id}`, `GET /v1/usage`) — and reports the real
  prepaid balance verbatim when the API returns one (never an invented figure).
  "Test generation" is billable, hard-bounded (128 completion tokens, `low`
  reasoning effort), and only runs on an explicit button press.
- **Workflow node `paperInstruments`**: new registry type with
  `name, model (empty = Settings fallback), system, prompt (both accept {{stepId}}
  templates), reasoningEffort (low|high|max, default low), maxOutputTokens
  (64–8192, default 512), responseSchema (optional JSON), timeoutSeconds
  (5–120, default 60)`. Full inspector fields, node card, palette entry, and
  renderer display metadata.
- **Generation path** (`POST /v1/chat/completions`): one documented non-streaming
  request per run — no retries of any non-idempotent operation, no silent model
  substitution anywhere. `finish_reason === 'length'` is reported as a truncation
  notice, not a failure; outputs are clamped at 64 000 chars. With a
  `responseSchema`, `json_object` mode is requested and the reply is validated
  locally against a documented JSON-Schema *subset*
  (`validateJsonDocument`: type/const/enum, string bounds+pattern, numeric bounds,
  array bounds+items, object properties/required/additionalProperties:false;
  unknown schema keywords are ignored — honestly documented as a subset). The
  validated JSON document is what flows downstream.
- **Credit protection**: the provider's own prepaid reservation (429
  `insufficient_quota`) is the primary protection. The local spending stop is a
  courtesy pre-check: when > 0 the runner first reads the free usage endpoint and
  refuses below its floor — or refuses without inventing figures when the read
  fails. With stop = 0 the check is skipped entirely. The live generation test
  needs a second explicit flag (`FLOWLOOM_LIVE_PAPER_GENERATION=1`).
- **Usage metadata**: `PaperGenerationMeta` (runTypes union with
  `BrowserOperationMeta`, discriminated by `'model' in meta`) records the model,
  finishReason, structured flag, and the provider's OWN usage numbers verbatim
  (prompt / completion / reasoning / total tokens) + the pre-call balance when
  checked. History's detail view renders the new shape (`GenerationMetaBlock`).
- **API interface used** (documented): `GET /v1/models`, `GET /v1/models/{id}`,
  `GET /v1/usage` (free), `POST /v1/chat/completions` (billable, explicit only).
  Error mapping per the documented table (401 auth; 403 suspended; 404
  model_not_found; 429 insufficient_quota→insufficient_credit vs
  rate/concurrency→rate_limit; 400 invalid_value param=model→model_not_found; 5xx).
- **Not implemented on purpose**: the document libraries (paper-docx / paper-pptx /
  paper-fsx / paper-xlsx) and `rubric` are Python-ecosystem-only and cannot be
  represented in this HTTP integration without faking them.

### New/changed files

Shared: `contracts.ts` (paper views + `PaperSettingsInput`, `insufficient_credit` /
`invalid_response` failure codes), `runTypes.ts` (meta union),
`nodeSchema.ts` (registry + `paperConfigSchema` + subset validator entry point),
`ipcChannels.ts` (`config:test-paper-generation`). Main:
`providers/paperinstruments.ts`, `services/execution/paperRunner.ts`,
`services/execution/paperExecutor.ts`, `config/service.ts`, `config/configRules.ts`,
`config/settingsSchema.ts`, `config/envSource.ts`, `config/secretKeys.ts`,
`services/connectionTests.ts`, `services/execution/executors.ts` + `engine.ts`
(credential gate + meta union), `ipc/register.ts`, `index.ts`. Preload:
`api.ts`, `index.ts`. Renderer: `SettingsPage.tsx`, `PaperSection.tsx`,
`settingsSupport.ts`, `HistoryPage.tsx`, `nodeTypes.tsx`, `nodeDisplay.ts`,
`NodeInspector.tsx`. Tests: `tests/main/paper.test.ts`,
`tests/main/paperRunner.test.ts`, `tests/live/paperLive.test.ts`. Tooling:
`scripts/live-check.mjs` (Paper free checks), `package.json` (`live:paper`).
`.env.example` documents both key names (`PAPERINSTRUMENTS_API_KEY`,
`PAPERINSTRUMENTS_MODEL`); the real `.env` was never modified or printed.

### Full gate results (this session)

typecheck ×2 pass, `eslint src` zero problems, vitest **211 passed + 6 skipped**
(new +45 paper tests; all 4 prior live tests still skipped correctly; the 2 new
paper live tests skip without flags), `npm run build` pass, `npm run smoke` pass.
The default test suite never sends a billable request.

 ### Live-request status (honest)

- **Free verification against the live API, Oct 23, 2026**: `npm run live:check` and
  `FLOWLOOM_LIVE_PAPER=1` vitest both exercised the production provider module:
  key accepted by `GET /v1/models`, the configured model id `ultramarine-1-flash`
  verified via `GET /v1/models/{id}`, and `GET /v1/usage` returned the real prepaid
  balance **$5.00 available (reserved $0.00)** in 3.3 s.
- **One live billable generation, Oct 23, 2026, explicit user approval**:
  `FLOWLOOM_LIVE_PAPER=1 FLOWLOOM_LIVE_PAPER_GENERATION=1` vitest sent one bounded
  `POST /v1/chat/completions` (`ultramarine-1-flash`, max 128 completion tokens,
  `low` reasoning effort, prompt "Reply with exactly the word: acknowledged") —
  HTTP 200, `finish_reason=stop`, provider usage verbatim: **19 prompt /
  5 completion / 1 reasoning / 24 total tokens in 1.5 s**. No subsequent balance
  was re-read for a delta figure (the API reports only what it reports; nothing
  was estimated).

### Remaining limits (truthful)

- One live `POST /v1/chat/completions` ran with explicit approval (24 real tokens
  billed, `finish_reason=stop`); workflow-node generation (engine path) is verified
  with mock HTTP responses only, and the in-app Run button was not clicked in this
  display-less environment — the engine + runner path is covered by the
  deterministic engine-level tests.
- Structured-output validation covers the documented subset only; schemas using
  un-supported keywords are accepted at config time and enforced only for the subset
  (stated in the UI and here).
- The in-app Run button was not clicked in this display-less environment; the engine
  + runner path is covered by the deterministic engine-level tests.
