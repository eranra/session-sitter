# Environment variables

**Settings are the source of truth.** Every supervisor variable below has a `sessionSitter.*` setting,
and a variable applies **only when the matching setting is unset**. Nothing requires an environment
variable any more; these are kept so an existing env-based install keeps working, and so a credential
can stay out of a plain-text synced `settings.json`.

Precedence, highest first. The doctor resolves values this way, so its report and the extension
agree:

1. an explicitly-set `sessionSitter.*` setting (workspace folder > workspace > user)
2. the process environment
3. `<parent of workspace root>/.env`, then `<workspace root>/.env`, then `<workspace root>/.supervisor.env`
4. the built-in default

An **empty** string in a path- or token-shaped setting counts as unset, which is what lets you leave
a credential setting blank and have the environment supply it.

## Where the `.env` files are read from

The **workspace root**, which is `sessionSitter.supervisorRepoPath` when set, else derived from an
explicitly-set state directory, else the first workspace folder. **Not your home directory** — a
`~/.env` is not read, and this is the commonest reason a `.env` appears to be ignored.

```
<parent of workspace root>/.env      lowest
<workspace root>/.env
<workspace root>/.supervisor.env     highest of the three
```

The format is deliberately minimal: `KEY=VALUE` lines, `#` comments, optional surrounding quotes. No
interpolation, no `export`, no multi-line values. A missing file is not an error.

**A boolean is `1`, `true`, `yes` or `on` (case-insensitive).** Every other value is false — so
`RED_NOTIFY=0`, `RED_NOTIFY=off` and `RED_NOTIFY=maybe` all disable it.

`node ../scripts/ss-config.mjs check` prints which of the three files exist and resolves every value
through the same order, so you can see what actually wins.

---

## Classifier

| Variable | Setting it falls back for | Default |
|---|---|---|
| `SUPERVISOR_ENGINE` | `sessionSitter.supervisor.engine` | `bob` |
| `BOBSHELL_API_KEY` **or** `BOB_API_KEY` | `sessionSitter.supervisor.bobApiKey` | — |
| `BOB_CLI_PATH` | `sessionSitter.supervisor.bobCliPath` | `bob` |
| `CLAUDE_CLI_PATH` | `sessionSitter.supervisor.claudeCliPath` | `claude` |
| `CLAUDE_TIMEOUT_SECONDS` | `sessionSitter.supervisor.classifierTimeoutSeconds` | `300` |
| `ANTHROPIC_BASE_URL` | `sessionSitter.supervisor.anthropicBaseUrl` | — |
| `ANTHROPIC_AUTH_TOKEN` | `sessionSitter.supervisor.anthropicAuthToken` | — |
| `FAST_CLASSIFIER` | `sessionSitter.supervisor.fastClassifier` | `1` |
| `FAST_CLASSIFIER_MODEL` | `sessionSitter.supervisor.fastClassifierModel` | — |
| `FAST_CLASSIFIER_TIMEOUT_SECONDS` | `sessionSitter.supervisor.fastClassifierTimeoutSeconds` | `10` |
| `FAST_CLASSIFIER_BASE_URL` | `sessionSitter.supervisor.fastClassifierBaseUrl` | — |

Either name works for Bob's key; `BOBSHELL_API_KEY` is tried first.

## Messaging

| Variable | Setting it falls back for | Default |
|---|---|---|
| `MESSAGING_CHANNEL` | `sessionSitter.supervisor.messagingChannel` | `stub` |
| `TELEGRAM_BOT_TOKEN` | `sessionSitter.supervisor.telegramBotToken` | — |
| `TELEGRAM_CHAT_ID` | `sessionSitter.supervisor.telegramChatId` | — |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `sessionSitter.supervisor.orangeResponseTimeoutMinutes` | `30` |
| `RED_NOTIFY` | `sessionSitter.supervisor.redNotify` | `true` |
| `NOTIFY_RULE_DECISIONS` | `sessionSitter.supervisor.notifyRuleDecisions` | `true` |

## Knowledge

| Variable | Setting it falls back for | Default |
|---|---|---|
| `KNOWLEDGE_LOCAL_REPO` **or** `KB_SITTER_LOCAL_REPO` | `sessionSitter.dataRepoPath` | — |
| `KNOWLEDGE_REPO` **or** `KB_SITTER_KNOWLEDGE_REPO` | `sessionSitter.supervisor.knowledgeRepo` | — |
| `KNOWLEDGE_REF` | `sessionSitter.supervisor.knowledgeRef` | `main` |
| `KNOWLEDGE_REGISTRY_PATH` | `sessionSitter.knowledge.registryPath` | — |

The `KB_SITTER_*` spellings are accepted second, for compatibility with the knowledge loader's own
naming.

## The Telegram remote interface

| Variable | Setting it falls back for | Default |
|---|---|---|
| `SESSION_SITTER_TELEGRAM_REMOTE_CONTROL` | `sessionSitter.telegram.remoteControl` | `false` |
| `SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS` | `sessionSitter.telegram.allowedUserIds` | — |
| `SESSION_SITTER_TELEGRAM_FULL_MESSAGES` | `sessionSitter.telegram.fullMessages` | `true` |
| `SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS` | `sessionSitter.telegram.maxMessageParts` | `4` |
| `SESSION_SITTER_TELEGRAM_MAX_TURNS_PER_PASS` | `sessionSitter.telegram.maxTurnsPerPass` | `12` |
| `SESSION_SITTER_TELEGRAM_STATUS_HOLD_SECONDS` | `sessionSitter.telegram.statusHoldSeconds` | `60` |
| `SESSION_SITTER_TELEGRAM_MIRROR_TOOL_ACTIVITY` | `sessionSitter.telegram.mirrorToolActivity` | `true` |
| `SESSION_SITTER_TELEGRAM_TOOL_ACTIVITY_SECONDS` | `sessionSitter.telegram.toolActivitySeconds` | `60` |

The allowlist is separated by **commas or whitespace**, because both are what people type into a shell
profile:

```bash
SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS="123456789, 987654321"
```

An unparsable number or an unrecognised boolean here **falls back to the default** rather than
throwing: a malformed `.env` should leave a setting at its default, not stop the daemon starting.

---

## Variables with no setting behind them

| Variable | Meaning |
|---|---|
| `ANTHROPIC_MODEL` | **The agent's own model.** The fast classifier judges with it by default, minus any trailing `[1m]` — a suffix an agent harness understands and a plain Messages endpoint rejects. Override with `FAST_CLASSIFIER_MODEL` to judge with something cheaper than the agent writes code with. |

---

## Two different questions, two different tables

This is the distinction to keep straight, because the answers differ and conflating them is how a
review goes wrong.

**"What does the extension read when this setting is blank?"** — the tables above. That is the question
a `settings.json` review asks, and it is what `ss-config.mjs check` resolves.

**"How does a terminal configure this setting?"** — `HEADLESS_EQUIVALENT` in
`src/settingsBridge.ts`, which names an answer for **all 42 settings** and is checked against
`package.json` in both directions by CI. The daemon, the CLI and the hooks read it; the extension does
not. Three kinds of answer, because there are genuinely three: an environment variable, a
command-line flag where the setting is *consent* to something with a side effect, or nothing needed
because the setting configures an IDE surface a terminal does not have.

`node ../scripts/ss-config.mjs schema` prints both — `envFallbacks` for the first question,
`headlessOnly` for the second.

`STATE_DIR` is the clearest divergence, and worth stating plainly: it is how the **daemon** sets its
state directory. **The extension never reads it** — it passes `sessionSitter.supervisorStateDir`
straight through — so setting `STATE_DIR` and leaving that setting blank leaves the AI supervisor off
in every IDE window.

The other settings a terminal reaches by flag or not at all:

| Setting | How a terminal sets it |
|---|---|
| `sessionSitter.supervisorRepoPath` | `--workspace-root` on `session-sitter daemon` — the repo is otherwise derived from the working directory, which a unit file sets rather than a shell |
| `sessionSitter.remotePeers` | `--peers` on `session-sitter status` — a flag typed at the moment of use is clearer consent to opening SSH connections than a variable inherited from a profile |
| `sessionSitter.sessionSort` | `--sort` on `session-sitter status` — the same six orders, per invocation rather than persisted |
| `sessionSitter.knowledge.user` / `.project` / `.team` | `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM`, which the **hooks** read — this is how a plugin-only install routes its practices. The extension reads only the settings. |
| `sessionSitter.autoSupervise` | nothing: whether `session-sitter daemon` is running is the headless control, and a stronger one |
| `sessionSitter.autoRespond` | nothing: there is no IDE approval-prompt queue to answer on a terminal-only machine |
| `sessionSitter.workspaceColors`, `.windowAttentionMinutes`, `.probelessActiveWindowMinutes`, `.debugCommands` | nothing: each configures an IDE surface. A variable wired to nothing is worse than its absence, because it implies the terminal has a panel |

---

## The Claude Code plugin

A hook is a bare Node process with no VS Code settings and no CLI flags, so the plugin's own knobs
are variables by necessity rather than legacy. It reads the classifier variables above **and** its
own — see [`PLUGIN.md`](PLUGIN.md).

---

## The daemon and the CLIs

`session-sitter daemon` keeps supervision running on a machine with no IDE — most importantly it is
what **expires an unanswered decision**, which is the mechanism behind *silence is never approval*.
With nothing running, an escalated call never reaches its deadline.

It has no Settings UI, so it is configured entirely through the environment and its flags. `STATE_DIR`
is its state directory and `--workspace-root` its repo. `session-sitter daemon --status` says whether
it is running and working.

`node out/supervisor/cli.js` and `node out/corpus/cli.js` likewise have no settings to read. All of
them take `--help`, and the flags are tabulated in
[`../../CONFIGURATION.md`](../../CONFIGURATION.md#cli-flags) and [`../../CLI.md`](../../CLI.md).

**Never run a second poller against a live window.** A bot token has one update stream and reading it
is destructive, so `supervise poll --loop` alongside `sessionSitter.autoSupervise: true` gives each
consumer a random half of the replies; Telegram answers the second with `409 Conflict`.
