# Brittain CLI — Build Plan (v1)

A lightweight, pure-Node, terminal-first version of Brittain Code, built in a
**new repository** by porting the essential runtime out of the Electron app
(`brittain-code`). The app is the reference implementation; v1 ports its
**core** — agent loop, curated tools, system prompts, memory, code
modes — and deliberately leaves everything else behind.

This document is written for coding agents. Read **§1 Rules** before touching
anything, then work **one milestone per PR** in the order given in **§8**.

---

## 0. Why this exists

1. **No signing.** The desktop app needs an Apple Developer ID to install
   cleanly. A CLI installed with `npm i -g` never gets the quarantine flag and
   runs under an already-signed `node`.
2. **Lightweight.** The app sends ~8k tokens of tool schemas and system prompt
   before the first message (55 code-mode tools, plus MCP servers like
   Playwright). On a ≤56k-context model that is a large share of the window.
   The CLI ships a curated tool set and a trimmed prompt with a hard token
   budget (§4).
3. **Works out of the box with Brittain 4.** First run talks to the Brittain
   API with no configuration beyond (optionally) a key.

### Goals (v1)
- `brittain` — interactive REPL in the current directory, **code**
  modes.
- `brittain -p "<prompt>"` — one-shot, non-interactive, scriptable.
- Three server modes, switchable at any time (§5): **Brittain** (default),
  **OpenAI-compatible**, **Ollama-compatible**.
- The core of Brittain Code's behaviour: agent loop, curated tools, approvals
  and safety invariants, system prompts, persistent memory, chat history and
  resume, compaction, `/context` and usage.

### Not in v1 (see §10 roadmap)
Discord bridge · daemon / LaunchAgent · triggers & heartbeats · unattended
`/agent` runs, parked calls, `/pending` · missions, `/orchestrate`, `/plan`,
`/review`, `/loop` · subagents (`run_subagent`) · MCP (client and trust) ·
PDF tools · browser tools · online research (`web_search`, `web_fetch`) ·
research-session tools · process-management tools (`start_process` etc.) ·
`calculate` · image / file attachments · Jev compaction · model install,
recommendations, hardware profiling, Brittainmark · sandboxing · custom autonomy
policies · `.brittain/` workspace triggers · auto-updater · any GUI · Windows
as a first-class target.

If a task seems to need one of these, stop and ask — don't pull it in.

---

## 1. Rules for agents (read first)

1. **Port, don't rewrite — but prune.** When code exists in `brittain-code`,
   copy it and change only what the move requires. Keep its comments; they
   record *why*. When a ported file contains code for a feature listed under
   "Not in v1", **delete that code** rather than carrying it dormant. Don't
   leave flags, stubs, or dead branches for deferred features.
2. **Provenance header.** Every ported file starts with
   `// Ported from brittain-code@<SOURCE_SHA>:<original/path.js>`. Files split
   out of `main.js` also cite the section header they came from
   (e.g. `main.js "---------- approval flow ----------"`).
3. **Find source by anchor, not line number.** Line numbers in §6 are hints for
   `SOURCE_SHA` and will drift. Search for the function name or section header.
4. **Zero runtime dependencies.** v1 needs none (the deps the app uses exist
   for PDF, math, and hardware features that are not in v1). Ask before adding
   any. Terminal UI is `node:readline` plus ANSI escape codes — **not** Ink,
   blessed, chalk, commander, yargs.
5. **CommonJS, plain JS, Node ≥ 22.** No TypeScript, no build step, no bundler.
   Match the source's style: `'use strict'`, `require`, factory functions
   (`createX({ deps })`) over classes, two-space indent, single quotes.
6. **Tests with `node:test`.** Every milestone ends green on `npm test`. Tests
   never call a real model — use the fake provider (§7).
7. **Stay inside the token budget** (§4). A test enforces it. If a change would
   break the budget, trim descriptions or ask; don't raise the limit.
8. **The safety invariants are not negotiable.** Destructive operations,
   sensitive reads, and anything that moves money always require a human,
   whatever mode or flag. If a port would weaken one, stop and ask.
9. **No globals in the core.** State from `main.js`'s top-level `let`s moves
   onto the runtime object (§6.3).
10. **Everything the core says goes through the sink.** The core never writes
    to stdout. The CLI renders events.
11. **Never print or log the Brittain endpoint** (§5.2).
12. **One milestone = one PR.** The description lists what was ported (source
    paths), what was pruned, deviations with reasons, and each acceptance check
    with its result.
13. **When the plan and the source disagree, the source wins** for behaviour;
    this plan wins for structure and scope.

---

## 2. Before starting (human)

- [x] Commit the `dev` work in `brittain-code` and record the commit as
      `SOURCE_SHA` below.
- [x] Create the new repo (suggested `brittain-cli`) with `brittain-code`
      checked out beside it at `../brittain-code`.
- [ ] Pick the npm package name. The binary is `brittain` either way.
- [ ] Decide the Brittain API details for §5.2 (endpoint, auth scheme, default
      model id). Agents scaffold with placeholders until then.
- [x] Copy this file into the new repo as `PLAN.md`.

`SOURCE_SHA = fa01d50fe707a9f72dfbad3550a56fe60effa14b`

---

## 3. Decisions (already made — don't relitigate)

| Topic | Decision |
|---|---|
| Runtime | Node ≥ 22 (`engines`). |
| Module format | CommonJS, `.js`, no build. |
| Entry point | `bin/brittain.js` (`"bin": { "brittain": "bin/brittain.js" }`). |
| Runtime deps | **None.** |
| Data dir | `~/.brittain/` (override `BRITTAIN_HOME`), mode `0700`. Holds `settings.json`, `credentials.json` (fallback only), `history/`, `memory/`, `repl_history`. |
| Secrets | macOS: Keychain via `/usr/bin/security` (service `brittain-cli`, account = secret name). Linux: `secret-tool` if on PATH. Fallback: `credentials.json` at `0600` with a plain warning that it is unencrypted (behaviour already in `src/main/secrets.js`). Env vars override: `BRITTAIN_API_KEY`, `OPENAI_API_KEY`. Never put a secret in a process argument visible to `ps`. |
| Default cwd | `process.cwd()`. |
| Default mode | `code`. ~~`/mode chat` or `--mode chat` switches.~~ **Chat mode removed (2026-09-23):** brittain.app covers chat, so the CLI is code mode only. Its prompt, tool set, settings (`defaultMode`, `chatTemperature`, `chatThink`, `globalChatInstructions`), user-wide memory, `/mode` and `--mode` are gone. |
| Default approval | Supervised: every risky tool asks. `--yes` / `/auto on` = trusted (risky tools run; invariants still ask). Only the two built-in policies from `src/main/autonomy.js`; no custom policies file. |
| REPL UI | `node:readline`, ANSI colors off when `NO_COLOR` is set or stdout isn't a TTY, minimal hand-rolled markdown (headings, bold, inline code, fences, lists). |
| Arg parsing | `node:util` `parseArgs`. |
| Wire protocols | Two transports only, both already in `src/main/inference.js`: `ollamaTransport` and `openAITransport`. The Brittain mode uses one of them (§5.2). |
| Distribution | npm. |

---

## 4. Lightweight by design: tools and token budget

### 4.1 Budget

Measured with the ported `context-estimator.js` over **system prompt + tool
schemas** for an empty conversation, no memory:

| Mode | Budget |
|---|---|
| code | **≤ 3,000 tokens** |
| ~~chat~~ | ~~≤ 800 tokens~~ (chat mode removed) |

`test/core/budget.test.js` builds both payloads exactly as the agent loop sends
them and fails over budget. The PR for M4 records the actual numbers next to
the app's (~8k) for comparison.

Because v1 sends full schemas for every tool, the app's tool-index/stubbing
machinery (`src/tools/tool-index.js`, `TOOL_INDEX_AUTO_BELOW`) is **not
ported**. If the budget ever needs it, that's a roadmap item.

### 4.2 v1 tool set

Port the implementations from `tools.js` (`executeTool` switch cases and their
helpers) **only for these tools**. Tool *descriptions* may be shortened to meet
the budget — keep the first sentence and any safety-relevant instruction;
drop references to tools that don't exist in v1.

**Code mode (17):**

| Tool | Risky? | Notes |
|---|---|---|
| `read_file` | | |
| `get_file_lines` | | |
| `browse_files` | | |
| `search_files` | | |
| `project_outline` | | from `src/tools/semantic-navigation.js` |
| `find_symbol` | | from `src/tools/semantic-navigation.js` |
| `write_file` | yes | |
| `edit_file` | yes | |
| `apply_patch` | yes | from `src/tools/apply-patch.js` |
| `delete_file` | yes | |
| `move_file` | yes | |
| `run_command` | yes | keep `isDestructiveCommand` and the financial-pattern check |
| `git_status` | | |
| `read_git_diff` | | |
| `get_git_log` | | |
| `ask_user` | | |
| `remember` | | memory (§4.3) |

~~**Chat mode (2):** `ask_user`, `remember`.~~ Chat mode removed (see §3).

Everything else in `tools.js` (≈40 tools) is not ported. The policy sets in
`src/tools/policy.js` (`RISKY_TOOLS`, `SENSITIVE_TOOLS`, `DESTRUCTIVE_TOOLS`,
`NETWORK_TOOLS`, `HOT_TOOL_NAMES`, `CHAT_TOOL_NAMES`) are pruned to names that
exist. `SUBMIT_IMPLEMENTATION_PLAN_TOOL` and other orchestration schemas are
not ported.

### 4.3 Memory

Port `memoryPath`, `readMemory`, the `remember` tool, and the legacy-path
fallback from `tools.js`, re-rooted under `~/.brittain/memory/`. Keep
`src/main/workspace.js`'s rule that if `<project>/.brittain/MEMORY.md` exists,
memory lives there (read and write) — but do **not** port `/workspace init`,
project triggers, heartbeats, or project `autonomy.json`. Keep the rule that
`remember` refuses key-shaped facts when memory is in-repo.

### 4.4 System prompts

Port `systemPrompt` (code) and `chatSystemPrompt` (chat) from `main.js` and
prune every line that refers to something not in v1: browser tools,
`run_subagent`, online research, attachments, research logs, windows/buttons.
Keep: explore-before-change, don't infer — read, commit and act, verify with
evidence, edit-tool preference order, command timeout, ask on ambiguity, don't
retry denied calls, remember lessons, be concise and report honestly. Memory
content is appended as data (as the source does), not as instructions.

---

## 5. Server modes

### 5.1 The three modes

| Mode id | Label | Endpoint | Key | Transport | Model |
|---|---|---|---|---|---|
| `brittain` | Brittain | built in, never shown (§5.2) | optional `BRITTAIN_API_KEY` / `brittain login` | per §5.2 (default OpenAI-compatible) | default `run4c-step-0116` |
| `openai` | OpenAI-compatible | user-supplied base URL (OpenRouter, Z.AI, Groq, DeepSeek, vLLM, …) | user-supplied, stored in keychain | `openAITransport` | user picks from `/v1/models` |
| `ollama` | Ollama | default `http://127.0.0.1:11434`, editable | none | `ollamaTransport` | user picks from `/api/tags` |

- **First run starts in `brittain` mode.** No setup prompt; the first message
  just works (given a key if the server requires one — if a request returns
  401/403, print one line telling the user to run `brittain login`).
- **Per-mode settings are kept separately** so swapping never loses a config:
  ```json
  {
    "provider": "brittain",
    "providers": {
      "brittain": { "model": "run4c-step-0116" },
      "openai":   { "endpoint": "https://openrouter.ai/api/v1", "model": "…" },
      "ollama":   { "endpoint": "http://127.0.0.1:11434", "model": "…" }
    }
  }
  ```
  Keys live in the secret store under `brittainApiKey` and `openaiApiKey`.
- **Switching:**
  - `/provider` → numbered picker showing the three modes and which is active;
    `/provider openai|ollama|brittain` switches directly.
  - `brittain --provider <mode>` for one invocation (does not persist).
  - Selecting `openai` with no endpoint or key walks the user through both
    (endpoint → key with echo off → fetch models → pick one). Selecting
    `ollama` pings the endpoint and lists models, or says Ollama isn't running.
  - The status line always shows the active mode and model.
- `/model` lists and fuzzy-matches models **for the active mode**.
- Context window: read from the server (Ollama `/api/show`; OpenAI-style
  `/v1/models` including `max_model_len`, as the source now does). Fall back to
  a per-mode default when unknown. Keep the source's `num_ctx` handling for
  Ollama.

### 5.2 The Brittain mode

- Endpoint lives in one place: `src/lib/providers/brittain.js`, exported as a
  constant (`https://api.brittain.app/v1`). A dev-only override
  `BRITTAIN_API_URL` is honoured but never
  documented in `--help`.
- It is **not** written to `settings.json`, **not** shown by `config get`,
  `/provider`, `/context`, `--verbose`, or error messages. Reuse
  `safeProviderError` from `inference.js` and extend it to redact this
  endpoint.
- Transport: `openAITransport` by default, selected by a single constant in the
  same file, so switching to an Ollama-shaped server is a one-line change.
- Auth: `Authorization: Bearer <key>` when a key is set; no header otherwise.
  Keep the header name in the same file so the human can change the scheme.
- Model-specific behaviour already in the source for Brittain 4
  (`isBrittain4Model`) is kept where it affects the core (context, thinking).
  Jev compaction is **not** in v1 — Brittain 4 uses native compaction.
- **Tell the human in the M2 PR:** an endpoint in an npm package is readable by
  anyone who opens the package. "Hidden" means kept out of the UI, not secret.
  Access control has to be server-side (keys, rate limits).

---

## 6. Source map

### 6.1 Copy from the source (Electron-free already)

Copy into `src/lib/` with provenance headers, then prune per Rule 1.

| Source | Port as | Pruning |
|---|---|---|
| `settings.js` | `src/lib/settings.js` | Replace single-endpoint fields with the §5.1 `providers` shape; drop settings for deferred features (`jev*`, `coderModel`, `scoutModel`, `toolIndex`, `sidebarOpen`, context caps for coder/scout, `compactionEngine`) |
| `tools.js` | `src/lib/tools/…` split into `files.js`, `search.js`, `git.js`, `shell.js`, `interact.js`, `memory.js`, `defs.js` | Only §4.2 tools |
| `src/tools/policy.js` | `src/lib/tools/policy.js` | Prune sets to v1 names |
| `src/tools/apply-patch.js`, `src/tools/semantic-navigation.js` | `src/lib/tools/` | — |
| `ollama-recovery.js` | `src/lib/` | — |
| `src/main/inference.js` | `src/lib/inference.js` | Keep both transports |
| `src/main/model-catalog.js` | `src/lib/` | — |
| `src/main/context-estimator.js`, `compaction.js`, `context-controls.js` | `src/lib/` | `context-controls`: drop tool-exclusion controls if they only serve the app's inspector UI |
| `src/main/history-store.js`, `sessions.js`, `chat-title.js` | `src/lib/` | `sessions`: only the `window`-equivalent key per chat; drop origin keys for Discord/triggers |
| `src/main/ledger.js`, `ledger-store.js` | `src/lib/` | — |
| `src/main/cost.js` | `src/lib/` | — |
| `src/main/tool-result.js`, `tool-failure.js` | `src/lib/` | `tool-result`: drop browser-evaluation bounding |
| `src/main/checkpoint-service.js`, `diff-service.js` | `src/lib/` | For `/undo` and `/diff` |
| `src/main/autonomy.js` | `src/lib/autonomy.js` | Built-in supervised/trusted only; drop custom policies, roots, sandbox, preconditions, narrowing, learning loop |
| `src/main/secrets.js` | `src/lib/secrets.js` | Remove `safeStorage`; add keychain backend (§3) |
| `src/main/run-sink.js` | `src/lib/run-sink.js` | Drop `renderer` target; add `listeners` fan-out; keep `TRANSCRIPT_CHANNELS` formatters (the REPL reuses them) |
| `src/main/workspace.js` | `src/lib/workspace.js` | Memory-location logic only |

**Not ported:** `mcp.js`, `attachments.js`, `missions.js`,
`recommendations.js`, `model-presets.json`, `model-baselines.json`,
`src/bridge/*`, `src/tools/{pdf,calculator,rendered-pages,attached-files,tool-index}.js`,
and `src/main/{daemon,triggers,project-triggers,run-queue,pending-store,decisions-log,mission-recovery,orchestration-plan,code-review,jev-compaction,local-browser-service,model-install-service,model-router,recommendations-service,benchmark-service,hardware-profile,sandbox,mcp-trust,update-service,window-security}.js`,
plus `preload.js`, `renderer/**`, `build/`, `benchmark/`, `scripts/*` (except
`run-tests.js`).

### 6.2 Split out of `main.js`

`main.js` sections are marked `// ---------- <name> ----------`. Only these are
ported; each becomes one `src/core/` module built as a factory that receives
the runtime (`createX(rt)`), with bodies kept close to the source.

| Core module | `main.js` section / anchor (≈ line) | Change |
|---|---|---|
| `context-hygiene.js` | `context hygiene` (134) | — |
| `state.js` | `conversation state` (286), `usage accounting` (361), session vars (190–262) | Drop attachments, online-research latch |
| `models.js` | `ollama helpers` (812) | Context/caps caches per provider mode; drop hardware profile |
| `approvals.js` | `approval flow` (1015): `requestApproval`, `looksFinancial`, `classifyToolCall` (1058), `activePolicy` (1128), `resolveToolCall` (1154) | `win.webContents.send` → `sink.emit('approval:request')` + `host.approve()`; drop MCP branches and parking |
| `questions.js` | `question flow` (1239) | Answered by the REPL; print mode answers `null` |
| `stream.js` | `streaming chat with ollama` (1280): `streamChat` (1281) | Provider from §5; `win?.webContents.send` → `sink.info` |
| `tool-call-parser.js` | `fallback tool-call parser` (1396) | — |
| `degradation.js` | `live psychosis detector` (1436) | Keep; it's cheap and protects small models |
| `prompts.js` | `chatSystemPrompt` (1590), `systemPrompt` (1629) | Prune per §4.4 |
| `agent-loop.js` | `agent loop` (1589): `activeToolDefs` (≈1750), `prepareAgentMessages` (1815), `runAgentTurn` (1887) | v1 tool sets only; drop MCP, tool index, online research, subagent paths |
| `chat-jobs.js` | `stageChatJob` (≈2484), `drainChatRuns` (2698), `chat:send` handler (2738) → `submitChat(payload)` | Drop attachments |
| `checkpoints.js` | `run checkpoints` (2294) | `app.getPath('temp')` → `os.tmpdir()` |
| `history.js` | `durable chat storage` (5392) | `host.dataDir` |
| `git.js` | `git integration` (5499) | — |
| `memory.js` | `memory viewer` (5534) | Return path instead of revealing in Finder |
| `compaction-runner.js` | `conversation compaction` (5753): `compactConversation` (5754) | Native path only; remove Jev |
| `context-inspector.js` | `context inspector` (5135) | Text output for `/context` |
| `export.js` | `chat export` (6059) | Path arg instead of save dialog |
| `title.js` | `generate chat title` (6099) | — |
| `commands.js` | `commandHandlers()` (≈569) + needed `ipcMain.handle`s | The core's API (§6.4) |

**Not ported from `main.js`:** `window`, `deliberation loops`, `auto-branch`,
`end-of-run report card`, `subagents`, `structured code review`,
`orchestrated coding`, `goal loop`, `durable missions`, `suspended runs`,
`triggers`, `misc ipc` (renderer-only), `benchmark data`, `policy learning
loop`, `MCP trust`, `discord bridge`, `daemon lifecycle`, updater wiring.

### 6.3 State inventory

| `main.js` global | Owner in v1 |
|---|---|
| `runtimeSettings`, `settingsUserDataDir` | `rt.config` |
| `sink` | `rt.sink` |
| `secrets` | `host.secrets` |
| `sessionId`, `sessionSpend` | `rt.session` |
| `conversation`, `conversationView`, `contextState`, `usage` | `rt.session` |
| `sessions`, `activeSessionKey` | `rt.sessions` (one key per chat) |
| `queuedChatRuns`, `stagingChatRuns`, `activeChatJob` | `rt.chatJobs` |
| `currentAbort`, `stopRequested`, `currentRun`, `lastFinishedRun` | `rt.run` |
| `modelSpeedSamples`, `contextCache`, `catalogDetails`, `capsCache`, `runtimeMetadataCache` | `rt.models` (keyed by provider mode + model) |
| `pendingApprovals`, `pendingQuestions` | `rt.approvals`, `rt.questions` |
| `checkpointService`, `historyStore`, `ledgerStore`, `diffService` | `rt.services` |
| Everything else (`win`, `activeMission`, `customPolicies`, `mcp`, `localBrowser`, `modelInstaller`, `hardwareProfile`, `daemonServer`, `discordBridge`, `runEventListeners`, `triggerTimer`, `workspaceHintShown`, `updateService`, `sessionOnlineResearch`, `sessionAttachments`) | not ported |

### 6.4 Command API (`rt.commands`)

One map; the REPL and print mode both go through it. Handlers return
`{ ok, … }` / `{ ok:false, error }` like the source.

`chat` · `stop` · `reset` · `approve` · `answer` · `compact` · `usage` ·
`cost` · `context.inspect` · `ledger` · `memory.get` · `history.list` ·
`history.load` · `history.delete` · `export` · `title` · `models.list` ·
`provider.get` · `provider.set` · `provider.setKey` · `provider.test` ·
`settings.get` · `settings.set` · `tools.list` · `git.status` · `git.diff` ·
`git.commit` · `checkpoint.undo`

---

## 7. Architecture

```
bin/brittain.js            argv → cli/
src/
  lib/                     §6.1 ports
    providers/brittain.js  endpoint, transport choice, auth header (§5.2)
    providers/index.js     mode registry: resolve {transport, endpoint, key, model}
    tools/                 §4.2 tools, split by area
  core/                    §6.2 split of main.js
    runtime.js             createRuntime({ host }) → { commands, events, shutdown }
    host.js                Host typedef
  host/
    node-host.js           createNodeHost() → Host
    paths.js               BRITTAIN_HOME
    keychain.js            security / secret-tool / file fallback
  cli/
    main.js                subcommand routing
    repl.js                interactive loop
    render.js              event → ANSI
    markdown.js
    prompts.js             approvals, questions, pickers, hidden input
    slash.js               slash-command dispatcher
    print-mode.js          -p
    first-run.js           provider setup flows
test/
  lib/  core/  cli/
  helpers/fake-provider.js
docs/
  events.md
```

### 7.1 Host interface (`src/core/host.js`)

```js
/**
 * @typedef {Object} Host
 * @property {string} dataDir
 * @property {string} tempDir
 * @property {{get(name):string, set(name,value):{ok,encrypted}, has(name):boolean, remove(name):void}} secrets
 * @property {(req: ApprovalRequest) => Promise<boolean|'always'>} approve
 * @property {(q: QuestionRequest) => Promise<any|null>} ask
 * @property {() => boolean} interactive
 */
```

Core tests use an in-memory test host with scripted approvals and answers.

### 7.2 Events

Channels are the source's `RUN_CHANNELS` (`run-sink.js`) minus
`stream:subagent`, `run:report`, `run:decisions`, plus:

| Channel | Payload |
|---|---|
| `approval:request` | `{ id, name, args, target, reason, kind }` |
| `approval:resolved` | `{ id, approved }` |
| `provider:changed` | `{ mode, model }` (never the Brittain endpoint) |

Events carry `{ chatId, runId, sequence }` metadata. `docs/events.md` is the
contract; it's written in M3 and kept current.

---

## 8. Milestones

Each: scope → acceptance. In order. Sizes are rough agent-session counts.

### M0 — Scaffold (S)
- `package.json` (`bin`, `engines`, `files`: `bin/ src/ README.md LICENSE`, no
  `dependencies`), `.gitignore`, MIT `LICENSE`, `README.md` stub, `CLAUDE.md`
  (Appendix A), `PLAN.md` (this file), `scripts/run-tests.js` (from source),
  GitHub Actions CI on `ubuntu-latest` + `macos-latest`, Node 22 and 24.
- `bin/brittain.js`: shebang, `--version`, `--help`.

Acceptance: `npm test` passes; `node bin/brittain.js --version` prints the
version; `npm pack --dry-run` lists only whitelisted files.

### M1 — Port the library (M)
- §6.1 files into `src/lib/`, pruned, with provenance headers.
- Port the source's behavioural tests for these modules. A source test is
  behavioural if it doesn't read `main.js`, `renderer/`, or `preload.js` as
  text; skip any test that covers pruned features.

Acceptance: `npm test` green; `grep -rn "require('electron')" src` empty;
`package.json` has no `dependencies`; no file under `src/` references a
tool name outside §4.2 (add a test that scans `src/lib/tools/defs.js`).

### M2 — Host, config, secrets, providers (M)
- `src/host/*`, keychain backend, `src/lib/providers/*` (§5).
- CLI: `brittain config get [key]` / `config set <key> <value>` (validated;
  Brittain endpoint never appears), `brittain login [--provider brittain|openai]`
  (hidden input), `brittain logout`, `brittain provider [mode]`,
  `brittain models`.
- First-run: absent `settings.json` → write defaults with `provider: "brittain"`.

Acceptance: fresh `BRITTAIN_HOME` → `provider` prints `brittain`; switching to
`openai` and back preserves each mode's model/endpoint; a key set via `login`
is in Keychain (macOS) and not on disk; `BRITTAIN_API_KEY` overrides; a test
greps every command's output and every thrown error for the Brittain endpoint
string and finds none; the PR includes the "hidden ≠ secret" note (§5.2).

### M3 — Runtime and streaming (M)
- `runtime.js`, `host.js`, `state.js`, `models.js`, `stream.js`,
  `tool-call-parser.js`, `degradation.js`, `context-hygiene.js`.
- `test/helpers/fake-provider.js`: a `node:http` server speaking Ollama
  `/api/chat` (NDJSON) and OpenAI `/v1/chat/completions` (SSE), replaying
  scripted turns (text, tool calls, malformed tool JSON, thinking, usage);
  also `/api/tags`, `/api/show`, `/v1/models`.
- `docs/events.md`.
- CLI: `brittain ask "<prompt>"` — one call, no tools, streams tokens.

Acceptance: `ask` streams in all three modes against the fake provider (the
Brittain mode pointed at it via `BRITTAIN_API_URL`); malformed tool JSON gets
the source's one retry; thinking goes to `stream:thinking` and is hidden unless
`--show-thinking`; 401 prints the `brittain login` hint.

### M4 — Tools, approvals, agent loop, print mode (L)
- `prompts.js`, `approvals.js`, `questions.js`, `agent-loop.js`,
  `chat-jobs.js`, `history.js`, `title.js`, `checkpoints.js`, `commands.js`.
- `brittain -p "<prompt>" [--model] [--provider] [--cwd] ~~[--mode code|chat]~~
  [--yes] [--output-format text|json|stream-json]`. Non-interactive: a call
  needing approval without `--yes` is **denied**, never hangs. Exit codes:
  `0` ok, `1` error, `2` finished with denied calls.
- `test/core/budget.test.js` (§4.1).
- Behavioural tests for the invariants: destructive command always asks (even
  with `--yes`), sensitive reads always ask, financial pattern always asks,
  denied call is not retried, repeated tool failure is tracked, tool results
  are bounded, writes stay inside cwd.

Acceptance: against the fake provider, `-p` completes a scripted task that
reads, edits, and runs a command in a temp git repo; `stream-json` emits one
event per line per `docs/events.md`; budget test passes with numbers recorded
in the PR.

### M5 — Interactive REPL (L)
- `repl.js`, `render.js`, `markdown.js`, `prompts.js`, `first-run.js`.
- Status line before each prompt: `provider/model · cwd · context %` (the mode was dropped with chat mode).
- Streamed assistant text; thinking dimmed and collapsed to one line after the
  turn; tool calls `→ name(args…)`, results `← name: first line` (reuse
  `TRANSCRIPT_CHANNELS`); a stats line after each turn (tokens, tok/s, cost
  when known).
- Approval: `Allow <tool> <target>? [y]es / [n]o / [a]lways this session / [v]iew`.
  Questions: numbered options plus free text.
- Keys: Enter sends; paste or trailing `\` for multiline; Ctrl-C once stops
  the run, twice at idle exits; Ctrl-D exits; ↑ history persisted to
  `~/.brittain/repl_history`.
- Sessions: `brittain` = new chat; `--continue` = latest chat for this cwd;
  `--resume [id]` = picker. Chats save automatically with generated titles.
- Flags shared with print mode.

Acceptance: render snapshot tests over a scripted run; Ctrl-C mid-stream stops
within one chunk and leaves history consistent; manual smoke in each provider
mode documented in the PR (Brittain mode once the server is up).

### M6 — Memory and context (M)
- Memory (§4.3) wired into both prompts.
- `compaction-runner.js`: auto-compact at `compactThreshold`, manual
  `/compact`; verbatim tail and ledger survive.
- `context-inspector.js`, usage and cost accounting, pinned files/messages.

Acceptance: a scripted long conversation crosses the threshold and compacts;
`remember` persists across chats and appears in the next prompt; in-repo
memory is used when `.brittain/MEMORY.md` exists; `/context` lists system
prompt, tools, and per-message tokens.

### M7 — Slash commands (M)

| Command | Behaviour |
|---|---|
| `/help` | Everything below, nothing more |
| `/clear` | New chat |
| ~~`/mode code\|chat`~~ | ~~Switch mode~~ (removed with chat mode) |
| `/provider [brittain\|openai\|ollama]` | §5.1 |
| `/model [name]` | Fuzzy match / picker for the active provider |
| `/auto on\|off` | Trusted vs supervised |
| `/think on\|off` | Thinking for the active mode |
| `/compact`, `/context`, `/usage`, `/cost`, `/ledger` | As source |
| `/memory` | Show memory and its path |
| `/diff` | Colored `git diff`; `$PAGER`/`less -R` when taller than the terminal |
| `/commit <msg>` | Stage all and commit |
| `/undo` | Restore the last checkpoint |
| `/history` | List/load/delete saved chats |
| `/export [path]` | Markdown export |
| `/tools` | Tools with risky/sensitive/destructive flags |

Acceptance: each command has a parse test; `/help` output matches the table.

### M8 — Release (S)
- README: install, quickstart (Brittain mode), switching providers
  (OpenRouter and Ollama examples), commands, data dir, safety model, what
  leaves the machine in each mode.
- `npm publish --dry-run` clean; version `0.1.0`.

Acceptance: on a fresh macOS user account: `npm i -g <pkg>` → `brittain` →
first message goes to the Brittain API with no Gatekeeper prompt; switching
to Ollama works with a local model.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Behaviour drift when splitting `main.js` | Factories that receive the runtime keep function bodies near-verbatim; behavioural tests for each invariant |
| Pruned prompts/descriptions make small models worse | Budget test plus a manual smoke on Brittain 4 and one small Ollama model per milestone from M4 |
| Source keeps moving | Pin `SOURCE_SHA`; after 0.1.0, sync by diffing the source from the pin to its new HEAD, porting relevant changes, bumping the pin |
| Brittain endpoint is extractable from the package | Documented (§5.2); access control is server-side |
| Keychain prompts on read | Verify in M2; fall back to the file store with a warning |
| Scope creep | "Not in v1" list (§0) plus Rule 1 |

---

## 10. Roadmap after v1 (order suggested, not committed)

1. Online research (`web_search`, `web_fetch`) behind `/online`.
2. ~~Subagents (`run_subagent`), and a scout-model setting.~~ **Done (2026-09-23):** `run_subagent` with the source's read-only tool set, and the `subagentModel` setting (empty = the lead's model, on the lead's provider).
3. Image and file attachments (`@path`).
4. Jev compaction for Brittain 4.
5. `/plan`, `/review`, `/orchestrate`, `/loop`, missions. **Partly done
   (2026-09-28):** `/build` (also `brittain build "<goal>"`) — see §10.1.
   The rest stay out.
6. MCP client (with trust), then Playwright MCP as the browser option.
7. Unattended `brittain run`, parked calls, custom autonomy policies, sandbox.
8. Daemon, triggers, heartbeats (launchd / systemd `--user`).
9. Discord bridge.
10. PDF tools, `calculate`.
11. Tool index / schema stubbing if the tool count grows past the budget.

### 10.1 `/build`: a code-driven orchestrator

Built because Brittain 4's window is small. A first attempt at "make a todo
app" in one agent turn spent ten of its twenty-five steps on a module-system
question and reported success over two real bugs. So the orchestrator is code
(`src/core/pipeline.js`), and the model is called for one narrow job at a
time, each with a small prompt of its own:

1. **scout** (read-only subagent) — only if the directory is not empty.
2. **plan** — one call, no tools, thinking **off** (with it on, the same call
   hit the repeat guard on two goals in three). The output is a fixed format
   (`src/core/plan.js`) that code validates; a bad plan goes back once with the
   errors. Saved to `.brittain/plan.md`.
3. **review** — the human reads the plan, may type a change (up to twice), and
   says yes. With nobody there, `--yes` builds without review; without it, the
   plan is written and nothing is built.
4. **per task**, in code: `coder` subagent with a brief (decisions, what earlier
   tasks built, its task) → the **harness** runs the task's `Check` → a
   read-only `verifier` subagent → mark done with evidence, retry once with the
   failure in the brief, or stop. A failed task, with someone there, asks for
   a hint (up to two) before giving up.

What is deliberately not a model decision:

- **Which task is next**, and **whether it is done.** A task is done only when
  its Check exits 0 (`runCommandStatus`, a real exit status), the Check's
  output reports no failure (a command that exits 0 while printing `✗` or
  `# fail 2` is not a check), and the verifier does not veto. `markTask`
  refuses `done` without evidence.
- **Whether a Check is any good.** Plan validation rejects a Check that is a
  sentence, a placeholder, or greps an error message through a pipe (stderr
  does not cross it).
- **What changed.** A before/after file snapshot (`src/core/snapshot.js`), not
  the coder's report. Files outside the task's list are named to the verifier.
- **Safety.** A coder's calls, and a planner-written Check, go through the same
  approval gate as the lead's. Destructive, sensitive and financial calls always
  ask; with nobody there they are denied. `--yes` does not change that.

The verifier is a second opinion, not the gate: on real runs it passed code
with a broken `done()`. The deterministic checks above are what caught the
same bug. Known limits: one coder at a time; a plan that is wrong is built
faithfully (the review step is the mitigation); `/undo` reverts the whole build
(the checkpoint taken when it started); checkpoint `diffStat` misses untracked
files (a ported bug, not used here).

Exit codes for `brittain build`: `0` every task done, `1` a task failed or the
run was stopped, `2` finished with denied calls.

---

## Appendix A — `CLAUDE.md` for the new repo

```markdown
# brittain-cli

Lightweight pure-Node CLI port of Brittain Code (the Electron app at
../brittain-code). The build plan is PLAN.md — read §1 Rules first, and work
only the milestone the human names.

- Node >= 22, CommonJS, no build step, no TypeScript, zero runtime deps.
- Terminal UI is node:readline + ANSI. No Ink/chalk/commander.
- v1 scope is PLAN.md §0. Anything under "Not in v1" is out — ask, don't add.
- Tool set is PLAN.md §4.2. System prompt + tools must stay under the §4.1
  token budget (enforced by test/core/budget.test.js).
- Three provider modes: brittain (default, endpoint never displayed), openai,
  ollama. See PLAN.md §5.
- Ported files carry `// Ported from brittain-code@<sha>:<path>`; keep the
  source's comments, delete code for features not in v1.
- src/core never writes to stdout and holds no module-global state.
- Safety invariants (destructive, sensitive, money → always a human) are never
  weakened by a mode, flag, or port.
- `npm test` passes before every commit. Tests never call a real model.
- One milestone per PR; the PR lists ported paths, pruned code, deviations,
  and acceptance results.
```

## Appendix B — Prompt to start a milestone

> Read PLAN.md §0, §1, §3, and milestone **M<n>** (plus any sections it
> references). The source is `../brittain-code` at `SOURCE_SHA`. Implement
> M<n> exactly as scoped, run `npm test`, and open a PR listing ported source
> paths, pruned code, deviations with reasons, and each acceptance check with
> its result. Stop and ask if a step would weaken a safety invariant, add a
> dependency, or pull in something from "Not in v1".
