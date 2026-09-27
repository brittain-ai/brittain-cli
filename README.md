# brittain-cli

A terminal coding agent. It is the command-line edition of
[Brittain Code](https://github.com/LukeMcB1128/brittain-code): the same agent
loop, tools, safety rules, memory and compaction, without the desktop app.

- Runs under the `node` you already have. Nothing to sign, nothing to
  notarize, no runtime dependencies.
- Small. The system prompt and tool schemas come to about 2,000 tokens in
  total (the desktop app sends about 8,700), which matters on a model
  with a 32k or 56k window.
- Works with Brittain 4 out of the box, and with any OpenAI-compatible
  provider or a local Ollama.

## Install

Requires Node 22 or newer.

```bash
npm i -g brittain-cli
```

## Quickstart

```bash
cd your-project
brittain
```

That starts an interactive session in the current directory, talking to
Brittain 4. If the server asks for a key:

```bash
brittain login
```

For a single prompt with no questions asked, use print mode:

```bash
brittain -p "explain what src/index.js does"
```

In print mode nobody is there to approve anything, so edits and commands are
denied unless you pass `--yes`. Destructive commands, sensitive reads and
anything that moves money are denied even then. The exit code is `0` on
success, `1` on an error, and `2` when the run finished with calls denied.
`--output-format json` prints one JSON object at the end;
`--output-format stream-json` prints every event as one JSON line (see
[docs/events.md](docs/events.md)).

## Providers

There are three provider modes. Each one keeps its own endpoint and model, so
switching back and forth loses nothing.

| Mode | What it talks to | Key |
|---|---|---|
| `brittain` (default) | the Brittain API | optional, `brittain login` or `BRITTAIN_API_KEY` |
| `openai` | any OpenAI-compatible API: OpenRouter, Z.AI, Groq, DeepSeek, vLLM | `brittain login --provider openai` or `OPENAI_API_KEY` |
| `ollama` | Ollama, by default at `http://127.0.0.1:11434` | none |

Switch with `brittain provider <mode>`, or `/provider` inside a session. Use
`--provider <mode>` to try one for a single run without changing the default.

**OpenRouter:**

```bash
brittain provider openai
# Base URL: https://openrouter.ai/api/v1
# API key (input hidden): sk-or-…
# then pick a model from the list
```

**Ollama:**

```bash
ollama pull qwen3:8b
brittain provider ollama   # lists your installed models; pick one
```

If Ollama runs somewhere else:
`brittain config set providers.ollama.endpoint http://gpu-box:11434`.

Every request carries a repetition penalty (default `1.05`), sent as
`repetition_penalty`, or `repeat_penalty` for Ollama. A provider that
refuses that field gets `frequency_penalty` instead. Change it with
`brittain config set repetitionPenalty 1.1`; `1` turns it off.

`brittain models` lists the models for the active provider, and `/model <part of
a name>` switches between them.

## In a session

Type a message and press Enter. End a line with `\` to keep typing on the
next one; a multi-line paste is sent as one message. Ctrl-C stops a run;
pressed twice at an empty prompt it exits, as does Ctrl-D. Up-arrow recalls
earlier input.

When the agent wants to change something it asks first:

```
Allow write_file src/app.js? [y]es / [n]o / [a]lways this session / [v]iew
```

`[a]lways` allows that kind of call for the rest of the session. For a
command it covers the program only: `[a]lways` on `ls -la` allows `ls`, not
`npm` or `kill`, and the prompt names what it covers
(`[a]lways npm this session`). It is not offered for destructive commands,
sensitive reads, payments, or a command with `$(…)`, backticks or a redirect
into a file.

`brittain --continue` picks up the latest chat started in this directory, and
`brittain --resume` offers a list. Chats save as you go and get a generated
title.

| Command | What it does |
|---|---|
| `/help` | List these commands |
| `/clear` | New chat |
| `/provider [brittain\|openai\|ollama]` | Show or switch the provider |
| `/model [name]` | Fuzzy-match or pick a model for the active provider |
| `/auto on\|off` | Trusted (edits and commands run without asking) or supervised |
| `/think on\|off` | Model reasoning on or off |
| `/compact` | Summarize older turns to free context |
| `/context` | Exactly what the next request will send, with token counts |
| `/usage`, `/cost`, `/ledger` | Tokens, spend, and what the session changed |
| `/memory` | What the agent has remembered, and where |
| `/diff` | Colored `git diff` of the working tree |
| `/commit <msg>` | Stage everything and commit |
| `/undo` | Restore the working tree to the checkpoint taken before the last run |
| `/history` | List, load or delete saved chats |
| `/export [path]` | Save the chat as Markdown |
| `/tools` | The tools and their risk flags |

For exploration that would read many files, the agent can hand the job to a
**subagent**: a read-only helper with its own context window that returns
only a findings report, so the file contents never fill up your conversation.
You see its steps as `⤷` lines. It can read and search, but never edit, run
commands or ask you anything; reading a secret like `.env` still asks you
first. It uses the same model unless you set another:
`brittain config set subagentModel <model>`.

A `BRITTAIN.md` in the project root is read into every session as
project instructions.

## Data

Everything lives in `~/.brittain/` (or `$BRITTAIN_HOME`), created with mode
`0700`:

| Path | Contents |
|---|---|
| `settings.json` | Provider modes, models, and preferences. `brittain config get` shows it; `brittain config set <key> <value>` changes it. |
| `history/` | Saved chats |
| `memory/` | Lessons saved with the `remember` tool, one file per project |
| `runs/` | Session ledgers written at compaction |
| `repl_history` | Your input history |
| `credentials.json` | Only when no keychain is available (see below) |

API keys go in the macOS Keychain, or the Secret Service (`secret-tool`) on
Linux. Where neither exists they go in `credentials.json` at mode `0600`, and
the CLI tells you they are unencrypted. `BRITTAIN_API_KEY` and
`OPENAI_API_KEY` override whatever is stored.

If a project has `.brittain/MEMORY.md`, that project's memory lives there
instead, in the repository. Anything shaped like a key is refused rather than
written into it.

## Safety

- File tools stay inside the working directory; a path that escapes it,
  directly or through a symlink, is refused. `.git/`, `.env*`, `*.pem`,
  `*.key` and anything listed in a `.brittainprotect` file are never written.
- Supervised (the default) asks before every edit, move, delete and command.
  Trusted (`/auto on`, `--yes`) runs those without asking.
- Destructive commands (`rm -rf`, `git push`, `sudo`, `git reset --hard`, `kill`,
  a download piped into a shell, and so on), reads of secrets (`.env`, keys,
  `.npmrc`), and anything that looks like it moves money always ask, even
  in trusted mode. With nobody there to ask, they are denied.
- Every run first snapshots the working tree to a hidden Git ref, so
  `/undo` can put it back even if you never committed.
- Memory and `BRITTAIN.md` are given to the model as data, not as
  instructions.

## What leaves your machine

- **brittain:** your messages, the files and command output the agent reads,
  and the system prompt go to the Brittain API.
- **openai:** the same, to the endpoint you configured.
- **ollama:** nothing leaves the machine unless your Ollama endpoint is
  somewhere else.

The CLI itself sends no telemetry.

## Development

```bash
git clone https://github.com/LukeMcB1128/brittain-cli
cd brittain-cli
npm link     # puts this checkout on your PATH as `brittain`
npm test
```

There is no build step and nothing to install. The code is laid out as:

| Path | Contents |
|---|---|
| `bin/` | The `brittain` entry point |
| `src/cli/` | The terminal: arguments, REPL, print mode, rendering, slash commands |
| `src/core/` | The agent runtime: loop, approvals, compaction, history, prompts |
| `src/host/` | Data paths and the keychain |
| `src/lib/` | Providers, tools, settings, and the stores |
| `test/` | Mirrors `src/`; tests run against a fake provider, never a real model |
| `docs/` | [The build plan](docs/PLAN.md) and the [event contract](docs/events.md) |

## License

See [LICENSE](LICENSE).
