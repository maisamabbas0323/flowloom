1| <p align="center">
2|   <img src="docs/assets/banner.svg" width="100%" alt="Flowloom — Connect it once. Let it run. Desktop workflow automation with a visual editor and a real execution engine." />
3| </p>
4| 
5| <h1 align="center">Flowloom</h1>
6| 
7| <p align="center">
8|   <strong>Connect it once. Let it run.</strong>
9| </p>
10| 
11| <p align="center">
12|   A desktop workflow-automation app: design workflows on a visual canvas, execute them with a real
13|   deterministic engine, and plug in browser automation, model generation, and spoken run feedback —
14|   all running locally on your machine.
15| </p>
16| 
17| <p align="center">
18|   <a href="https://www.electronjs.org/"><img alt="Electron 45" src="https://img.shields.io/badge/Electron-45-47848f?logo=electron&logoColor=white" /></a>
19|   <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black" /></a>
20|   <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white" /></a>
21|   <a href="https://tailwindcss.com/"><img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06b6d4?logo=tailwindcss&logoColor=white" /></a>
22|   <a href="https://vitest.dev/"><img alt="vitest" src="https://img.shields.io/badge/tests-vitest-729b1b?logo=vitest&logoColor=white" /></a>
23| </p>
24| 
25| <p align="center">
26|   <a href="#what-is-flowloom">What is Flowloom?</a> ·
27|   <a href="#at-a-glance">At a glance</a> ·
28|   <a href="#how-it-works">How it works</a> ·
29|   <a href="#quick-start">Quick start</a> ·
30|   <a href="#configuration-and-environment-variables">Configuration</a> ·
31|   <a href="#your-first-workflow">First workflow</a> ·
32|   <a href="#project-architecture">Architecture</a> ·
33|   <a href="#integrations-and-providers">Integrations</a> ·
34|   <a href="#development-commands">Commands</a> ·
35|   <a href="#contributing">Contributing</a>
36| </p>
37| 
38| ---
39| 
40| ## What is Flowloom?
41| 
42| Most automation tools force a choice: a browser-only toy that can't run code you trust, or a
43| developer framework that demands you write glue for every step. Flowloom sits in between. It is a
44| native **desktop application** where you assemble a workflow from typed, validated steps on a
45| visual canvas — trigger, text, delay, condition, join, browser action, model generation — and run
46| it with a real engine that executes those steps deterministically, reports exactly what happened,
47| and refuses to lie about what it didn't do.
48| 
49| Flowloom is for developers, tinkerers, and automation-minded people who want:
50| 
51| - a **visual editor** that persists every graph, pan, and zoom exactly as you left it;
52| - a **execution engine** that runs in the main process with honest statuses, real cancellation,
53|   branching, joins, and per-node timelines — no fake progress bars;
54| - **integrations you configure once**: Browserbase for real remote-browser steps, ElevenLabs for
55|   spoken run feedback, Paper Instruments (Ultramarine API) for bounded model generation;
56| - **local-first data**: workflows, run history, and artifacts live in your Electron `userData`
57|   directory. Nothing is uploaded anywhere except the calls you explicitly configure.
58| 
59| Honesty is a design constraint here. A browser step that can't find a selector says so; a run that
60| fails names the node that failed; an unconfigured provider refuses before any request is made rather
61| than substituting something plausible. Empty states are truthful, and there is no fake data
62| anywhere in the app.
63| 
64| **What runs today:** the visual editor, workflow persistence, the deterministic execution engine
65| (trigger / data / delay / condition / join), real Browserbase sessions (navigate, extract, click,
66| fill, wait, screenshot), Paper Instruments generation, run history with search/filter/delete/clear,
67| and optional ElevenLabs narration.
68| 
69| ## At a glance
70| 
71| | Capability | What it actually does | Status |
72| | --- | --- | --- |
73| | Visual workflow editor | Drag-and-drop canvas (`@xyflow/react`), undo/redo, node library, per-node inspector, autosave (~500 ms debounce) with zoom/pan restore | ✅ Implemented |
74| | Workflow persistence | One JSON file per workflow + index under `<userData>/workflows/`; validated in the main process before every save | ✅ Implemented |
75| | Execution engine | Promise-graph scheduler, deterministic branching, real cancellation, 3-run concurrency cap, one run per workflow | ✅ Implemented |
76| | Trigger node | Manual start; per-run metadata, race-free | ✅ Implemented |
77| | Data / text node | Holds a value; `{{stepId}}` templates resolve against *finished* upstream outputs (no `eval`, 64 KB payload cap) | ✅ Implemented |
78| | Delay node | Real cancellable wait, 1–3600 seconds | ✅ Implemented |
79| | Condition node | Six deterministic operators (`contains`, `doesNotContain`, `equals`, `notEquals`, `isEmpty`, `isNotEmpty`) with `Matches` / `Otherwise` branches | ✅ Implemented |
80| | Join node | `all` (wait for every branch) and `any` (first success wins) | ✅ Implemented |
81| | Browser action node | Real Browserbase sessions over CDP: `navigate`, `extractPageText`, `extractText`, `click`, `fillField`, `waitFor`, `pageInfo`, `screenshot` | ✅ Implemented (live-verified) |
82| | Model generation node | Paper Instruments chat completions with bounded tokens, optional JSON-schema-subset validation, honest usage numbers | ✅ Implemented (live-verified) |
83| | Cancellation | Real cancel: timers cleared immediately, pending nodes marked `cancelled`, terminal state never rewritten to success | ✅ Implemented |
84| | Run history | Newest-first list, node-level timelines, browser/model metadata, search, status filters, per-run delete and clear-all, 200-run retention | ✅ Implemented |
85| | Voice feedback | Optional ElevenLabs narration of run started/succeeded/failed/cancelled and browser-step completion; mute toggle during runs | ✅ Implemented (off by default) |
86| | Language engine settings | Google AI / OpenRouter / Ollama connection tests with per-section credential storage | ✅ Settings implemented · **no workflow node yet** |
87| | Artifact store | Screenshots stored under `<userData>/artifacts/`, surfaced only through one validated IPC (renderer never sees a filesystem path) | ✅ Implemented |
88| | Automatic retries | Nothing is silently retried anywhere | ⛔ By design (not present) |
89| | Packaged installers | No `electron-builder`/installer pipeline | ⛔ Not present (run from source or `out/`) |
90| 
91| ## How it works
92| 
93| Flowloom separates the **canvas** (what you designed) from the **engine** (what actually runs).
94| The renderer never executes a step itself. When you press **Run**:
95| 
96| 1. The dirty graph is saved first — the engine executes exactly the persisted record; a failed save
97|    refuses to start.
98| 2. The main process independently re-validates the record: structure (acyclic, no dangling edges,
99|    known types), per-node configuration completeness, trigger connectivity, and reachability.
100|    Problems come back as actionable, per-node messages before any side effect occurs.
101| 3. Credential gates run before side effects too — a workflow containing a browser step without
102|    Browserbase credentials is refused before a session is ever created.
103| 4. The scheduler builds one deferred promise per edge. A node runs when all its incoming edges are
104|    terminal; a `join: any` node proceeds on the first success; fully-skipped branches skip
105|    downstream instead of deadlocking joins.
106| 5. Each finished node publishes its output (size-capped, secret-redacted) to downstream steps.
|    `{{stepId}}` references in text fields resolve against finished upstream outputs only.
107| 6. Every transition is streamed to the renderer over a push channel and written to run history
108|    incrementally (atomic temp+rename, serialized writes).
109| 7. Cancellation flips a per-run signal: delay timers clear immediately, pending nodes become
110|    `cancelled`, and the terminal state is final.
111| 
112| ```mermaid
113| flowchart LR
114|     A[Trigger<br/>manual start] --> B[Data / text<br/>{{stepId}} templates]
115|     B --> C{Condition<br/>contains …}
116|     C -->|Matches| D[Delay<br/>real wait]
117|     C -->|Otherwise| E[Browser action<br/>navigate · extract · screenshot]
118|     D --> F[Join<br/>all / any]
119|     E --> F
120| ```
121| 
122| *A real example assembled entirely from implemented node types.* Everything in this diagram exists
123| today; it is illustrative of one shape, not a required pattern.
124| 
125| ## Quick start
126| 
127| **Prerequisites**
128| 
129| - **Node.js 22** (this is the version the project is developed and verified on; see
130|   [`package.json`](package.json) — no `engines` field is declared, so other recent Node versions
131|   may work but are untested here).
132| - **npm** (the lockfile is npm's).
133| - On **headless Linux**, running the packaged app or the smoke test needs `xvfb-run` (the smoke
134|   script wraps itself automatically).
135| - Internet access is only required when a workflow step (or a Settings connection test) actually
136|   calls a provider. The editor, engine, and local node types run fully offline.
137| 
138| **Install and run in development**
139| 
140| ```bash
141| git clone https://github.com/maisamabbas0323/flowloom.git
142| cd flowloom
143| npm install        # installs dependencies (Electron binary included)
144| npm run dev        # starts electron-vite in dev mode with hot reload
145| ```
146| 
147| **Production build**
148| 
149| ```bash
150| npm run build      # electron-vite build → out/main, out/preload, out/renderer
151| npm start          # electron-vite preview: runs the built app
152| ```
153| 
154| Build artifacts land in `out/`:
155| 
155| | Artifact | Path |
156| | --- | --- |
157| | Electron main entry | `out/main/index.js` |
158| | Preload bridge | `out/preload/index.js` |
159| | Renderer bundle | `out/renderer/` |
160| 
161| There is currently **no installer/packaging pipeline** (no `electron-builder`); the app is run
162| either via `npm run dev`, `npm start`, or directly with Electron against `out/main/index.js`.
163| 
164| > **Note on `npm install`:** the Electron postinstall downloads a platform binary from GitHub
165| > releases. On networks where that CDN stalls, the download can crawl — if it does, see
166| > [Troubleshooting](#troubleshooting).
167| 
168| ## Configuration and environment variables
169| 
170| Flowloom reads provider configuration from two places, in a strict, documented order:
171| 
172| > **Saved Settings override → `.env` file → the one documented default**
173| 
174| Settings values always win. Clearing a saved override in the app re-exposes the `.env` value. The
175| `.env` file itself is never written or modified by the app. `.env` lookup order:
176| `FLOWLOOM_ENV_PATH` → `<userData>/.env` → `<cwd>/.env` (for unpackaged runs such as dev).
177| 
178| Copy the template to get started:
179| 
180| ```bash
181| cp .env.example .env
182| ```
183| 
184| [.env.example](.env.example) documents every recognized variable. Secrets (API keys) are stored
185| encrypted with the OS credential store (`safeStorage`) in `<userData>/secrets.json`; **values are
186| never sent to the renderer process and never logged**. If the OS has no secure storage available,
187| keys are held session-only rather than written to disk unencrypted.
188| 
189| ### Language engine — Google AI, OpenRouter, Ollama
190| 
190| ...