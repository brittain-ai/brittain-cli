# Run events

The core never writes to the terminal. Everything a run has to say is an event
on `rt.sink`, and whoever holds the runtime subscribes:

```js
const { events } = createRuntime({ host });
const unsubscribe = events.subscribe((channel, payload, meta) => { /* … */ });
```

This file is the contract between the core and every consumer: the REPL
renderer, print mode, and `--output-format stream-json`, which writes one JSON
object per event per line:

```json
{"channel":"stream:token","payload":"Hel","chatId":"c-1","runId":"run-…","sequence":7}
```

## Metadata

Every event carries `meta`:

| Field | Meaning |
|---|---|
| `chatId` | The chat the run belongs to (empty for `brittain ask`). |
| `runId` | The run that produced the event. |
| `sequence` | Increases by one per event, per runtime. Consumers can detect gaps. |

## Channels

| Channel | Payload | When |
|---|---|---|
| `stream:state` | string, e.g. `"starting"`, `"compacting"`, `"auto-compacting (recovering)…"` | A phase change worth a status line. |
| `stream:info` | string | A notice for the person: a retry, a warning, a recovery. |
| `stream:thinking` | string (a fragment) | Reasoning, as it streams. Hidden by default; `--show-thinking` shows it. Never part of the answer. |
| `stream:token` | string (a fragment) | Answer text, as it streams. |
| `stream:cleancontent` | string | The full answer text with recovered tool-call markup removed; replaces what `stream:token` showed for that step. |
| `stream:message` | string | A completed assistant message, for consumers that cannot render tokens. |
| `stream:toolcall` | `{ name, args }` | A tool call is about to be resolved (approved, denied, or run). |
| `stream:toolresult` | `{ name, result, denied? }` | What the tool returned. `result` is a preview; `denied` is true when it did not run. |
| `stream:subagent` | `{ phase: 'start', task, model, role }` · `{ phase: 'tool', name, args }` · `{ phase: 'done', steps, note? }` | A subagent run — a `run_subagent` scout, or a `/build` scout, coder or verifier (`role`): it starting, each tool it calls, and its finish. `note` says why it stopped early. Its model output is not streamed; its report arrives as the `run_subagent` `stream:toolresult`. |
| `stream:stats` | `{ contextTokens, contextLength, tokPerSec, scope }` | Context use. `scope` is `"provider"` (one inference's own counts) or `"conversation"` (the size of the next request). |
| `stream:cost` | `{ text, cost, promptTokens, evalTokens, sessionText }` | Once per turn, only when the provider is not local. `cost` is `null` when the provider publishes no rates — unknown, not free. |
| `stream:done` | `{ ok, error?, stopped?, stats? }` | The run finished. Always the last event of a run. |
| `question:request` | `{ id, questions: [{ question, options }] }` | `ask_user` is waiting. The host's `ask()` answers it. |
| `approval:request` | `{ id, name, args, target, reason, kind, always }` | A tool call was put to a human. `kind` is `{ destructive?, sensitive?, financial? }`. `always` names what answering `'always'` would allow for the rest of the session (`"this session"`, or the programs of a command, such as `"npm this session"`), and is `null` when it is not offered. The host's `approve()` answers it. |
| `approval:resolved` | `{ id, approved }` | The answer to an `approval:request`. |
| `provider:changed` | `{ mode, model }` | The active provider or model changed. Never carries the Brittain endpoint. |

## Rules

- Events are announcements. Answers to questions and approvals come back
  through the Host (`src/core/host.js`), not through the sink.
- No payload ever contains the Brittain endpoint or an API key.
- A listener that throws is skipped; the run continues.
