# Every setting, and the question to ask about it

All 42 settings, grouped the way the Settings UI groups them. Type, default, range and scope come
from the extension's own declaration.

**Do not treat this table as authoritative for a build you have in front of you.** It was written
against version 0.8.10. Run `node ../scripts/ss-config.mjs schema` and read the live values — that
is the whole reason the script exists.

Two columns need a word:

- **Scope** — `machine` settings never sync between machines and cannot be set per workspace: the
  three credentials, so a token does not end up in a committed workspace file.
  `machine-overridable` is the paths, which are machine-specific but may still be pointed elsewhere
  by a workspace. `window` is everything else.
- **Ask** — what to put to the user, and what their answer decides. A setting with no question is
  one to leave alone unless they raise it.

---

## Session panel

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.sessionSort` | string | `"recent"` | window |
| `sessionSitter.workspaceColors` | object | `{}` | window |
| `sessionSitter.probelessActiveWindowMinutes` | number ≥ 0 | `120` | window |
| `sessionSitter.windowAttentionMinutes` | number ≥ 0 | `0` | window |
| `sessionSitter.remotePeers` | string | `"auto"` | window |
| `sessionSitter.autoRespond` | array | `[]` | window |

**`sessionSort`** — one of `recent`, `hostWorkspace`, `workspace`, `source`, `title`, `status`.

> **Ask:** "Does the list re-ordering itself bother you?" `recent` (the default) sorts by newest
> activity, so rows move whenever any session updates. `hostWorkspace`, `workspace`, `source` and
> `title` hold rows still — a row only moves when a session appears or disappears. `status` puts
> what needs you first, and does move.

The list is capped by recency *before* it is sorted — 20 rows in Sessions, 50 in History — so an
alphabetical order never hides the sessions they touched most recently. An unrecognised value falls
back to `recent` rather than failing. The panel's **⇅** toolbar button writes this setting, so they
can also just click it.

**`workspaceColors`** — keys are matched in the order written, **first match wins**. A key is a
workspace name (`my-app`), a full path (`/home/you/work/my-app`), or a glob over either (`*` is any
run of characters, `?` is exactly one; `*` alone is the catch-all). A value is a hex colour (`#0f8`,
`#1a2b3c`), `auto`, or one of: `red` `orange` `amber` `yellow` `lime` `green` `teal` `cyan` `blue`
`indigo` `violet` `purple` `magenta` `pink` `brown` `slate` `gray`.

> **Ask:** "Several projects open at once?" If yes, offer `{"*": "auto"}` first — every workspace
> gets its own stable colour derived from its name, the same colour in every window and on every
> machine, with nothing to name by hand. Name individual colours only where they want a specific
> one.

The label colour is chosen automatically for contrast. A value that is not a colour is ignored and
that pill stays on the theme colour, rather than being painted something arbitrary — the doctor
reports it as `bad-colour`.

**`probelessActiveWindowMinutes`** — how recently a **Codex** or **VS Code Chat** session must have
been updated to count as active. Those sources expose no live-process signal, so recency is the only
honest proxy; Claude and Bob are judged by what their extension hosts report as open. `0` keeps them
in History always.

> **Ask:** only if they use Codex or VS Code Chat and those sessions come and go from the list at the
> wrong moment.

**`windowAttentionMinutes`** — how long after someone last touched an IDE window that window's report
of its open sessions still counts. `0`, the default, means off.

> **Ask:** only on a **remote** setup, and only if sessions vanish from the list too eagerly or linger
> after disconnecting.

This exists for remote IDEs specifically. The process publishing a window's open sessions is the
**server-side** extension host, and closing the client window does not stop it — the server keeps it
alive for a reconnect, so it goes on reporting the sessions that were open when you disconnected.
Setting this makes those reports expire. **Raise it rather than lower it** if a session they are
working in moves to History too eagerly. Windows running a build too old to publish the signal are
always treated as attended.

**`remotePeers`** — `auto` or `off`.

> **Ask:** "Do you work on more than one machine?" `auto` needs no configuration at all: peer
> addresses are mined from the remote windows this IDE has already opened, so the address used is the
> exact one the IDE itself connects with. Offer `off` if they would rather the extension never invoke
> `ssh`.

Only peers reachable from this machine appear. SSH runs with `BatchMode=yes`, so a host that would
prompt for a password is reported unreachable rather than blocking the poll. Clicking a peer session
focuses the window on **its own** machine — the agent is running there.

**`autoRespond`** — see [`AUTO-RESPOND.md`](AUTO-RESPOND.md).

---

## Supervision

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.supervisorStateDir` | string | `""` | machine-overridable |
| `sessionSitter.autoSupervise` | boolean | `true` | window |
| `sessionSitter.supervisorRepoPath` | string | `""` | machine-overridable |

**`supervisorStateDir`** — **the one setting that turns the AI supervisor on.** Holds `history/`,
`records/`, `outbox/`, `inbox/`, `notifications/`, `locks/`, and is created on first use.

> **Ask:** "Do you want an agent judging the prompts your agents pause on, or just the deterministic
> rules?" Suggest a directory outside any repository — `~/.ai-sessions/state` — since a supervised
> agent should not be able to write to its own decision records.

Left unset, the extension still records deterministic rule decisions under its own global storage, so
the activity panel works without it. Only the supervisor stays off.

**The extension does not read `STATE_DIR`.** That variable is how `session-sitter daemon` and the CLI
set their state directory; the extension passes this setting through directly. So setting `STATE_DIR`
and leaving this blank leaves the supervisor off in every IDE window.

**`autoSupervise`** — hand every prompt no rule handled to the supervisor, and poll for replies and
timeouts. On by default, and there is no daemon to start.

> **Ask:** only if they want the supervisor available for the **Supervise the Blocked Session Now**
> command but not applied automatically.

**`supervisorRepoPath`** — the classifier's working directory, and the root the `.env` layers are read
from. Derived from the state directory's parent when empty.

> **Ask:** only if a `.env` is not being picked up, or the classifier needs to run somewhere specific.

---

## Classifier

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.supervisor.engine` | string | `"bob"` | window |
| `sessionSitter.supervisor.bobCliPath` | string | `"bob"` | machine-overridable |
| `sessionSitter.supervisor.claudeCliPath` | string | `"claude"` | machine-overridable |
| `sessionSitter.supervisor.bobApiKey` | string | `""` | **machine** |
| `sessionSitter.supervisor.anthropicBaseUrl` | string | `""` | window |
| `sessionSitter.supervisor.anthropicAuthToken` | string | `""` | **machine** |
| `sessionSitter.supervisor.classifierTimeoutSeconds` | number ≥ 10 | `300` | window |
| `sessionSitter.supervisor.fastClassifier` | boolean | `true` | window |
| `sessionSitter.supervisor.fastClassifierModel` | string | `""` | window |
| `sessionSitter.supervisor.fastClassifierTimeoutSeconds` | number ≥ 1 | `10` | window |
| `sessionSitter.supervisor.fastClassifierBaseUrl` | string | `""` | window |

**`engine`** — `bob` (IBM Bob Shell) or `claude` (Claude Code).

> **Ask:** "Which agent CLI do you have — `bob` or `claude`?" **Set this explicitly.** The default is
> `bob`, which needs an API key, so a configuration that never mentions the engine and never sets a
> key has a classifier that cannot run. The doctor reports that as `engine-needs-key`.

**`bobCliPath`** / **`claudeCliPath`** — only needed when the binary is not on the `PATH` the
extension host sees. On a remote setup that is the `PATH` of the machine the host runs on, not the
one in their terminal.

**`bobApiKey`** — Bob's headless auth. Empty falls back to `BOBSHELL_API_KEY`, then `BOB_API_KEY`.

> **Ask:** if the engine is `bob`. Offer the environment as the better home — VS Code stores settings
> in plain text.

**`anthropicBaseUrl`** / **`anthropicAuthToken`** — the gateway and token passed into the `claude`
subprocess, and the fast tier's defaults. Empty falls back to `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN`.

> **Ask:** only if they run Claude against a gateway or an API key rather than a subscription.

**`classifierTimeoutSeconds`** — per-invocation timeout, both engines. Minimum 10.

**`fastClassifier`** and its three companions — see the fast-classifier section in
[`../SKILL.md`](../SKILL.md#layer-6--the-fast-classifier) and
[`../examples/06-fast-classifier-gateway.json`](../examples/06-fast-classifier-gateway.json).
`fastClassifierModel` empty uses the agent's own `ANTHROPIC_MODEL`, minus any trailing `[1m]` — a
suffix an agent harness understands and a plain Messages endpoint rejects.

---

## Messaging

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.supervisor.messagingChannel` | string | `"stub"` | window |
| `sessionSitter.supervisor.telegramBotToken` | string | `""` | **machine** |
| `sessionSitter.supervisor.telegramChatId` | string | `""` | window |
| `sessionSitter.supervisor.orangeResponseTimeoutMinutes` | number ≥ 1 | `30` | window |
| `sessionSitter.supervisor.redNotify` | boolean | `true` | window |
| `sessionSitter.supervisor.notifyRuleDecisions` | boolean | `true` | window |
| `sessionSitter.telegram.remoteControl` | boolean | `false` | window |
| `sessionSitter.telegram.allowedUserIds` | array of string | `[]` | window |
| `sessionSitter.telegram.fullMessages` | boolean | `true` | window |
| `sessionSitter.telegram.maxMessageParts` | number 1–20 | `4` | window |
| `sessionSitter.telegram.maxTurnsPerPass` | number 1–50 | `12` | window |
| `sessionSitter.telegram.statusHoldSeconds` | number 0–3600 | `60` | window |
| `sessionSitter.telegram.mirrorToolActivity` | boolean | `true` | window |
| `sessionSitter.telegram.toolActivitySeconds` | number 0–3600 | `60` | window |

**`messagingChannel`** — `stub` or `telegram`. `stub` writes cards to `<stateDir>/notifications/` and
reads replies from `<stateDir>/inbox/`.

> **Ask:** "Do you want decision cards on your phone, or written to files while you get a feel for
> it?" Suggest `stub` for the first day — an Orange nobody receives times out and **denies**.

Set to `telegram` with the token or chat id missing, the stub is used and a warning is logged.
Supervision degrades rather than failing silently, which also means it can look like nothing
happened — the doctor reports it as `telegram-incomplete`.

**`telegramBotToken`** — from BotFather. Empty falls back to `TELEGRAM_BOT_TOKEN`.

> **Ask:** and then recommend the **environment**, not this setting. See
> [`TELEGRAM-SETUP.md`](TELEGRAM-SETUP.md#one-bot-per-machine).

**`telegramChatId`** — required for `telegram`. Empty falls back to `TELEGRAM_CHAT_ID`. A group id is
**negative**; a supergroup starts `-100`. Not a secret, so settings are fine.

**`orangeResponseTimeoutMinutes`** — how long a card waits before it denies and hands the agent safe
alternatives.

> **Ask:** "How long should an unanswered decision wait before it denies?" Shorter unblocks the agent
> sooner; longer gives them more time to answer from a phone.

**`redNotify`** — whether a Red also posts a one-way alert. The block stands either way.

**`notifyRuleDecisions`** — whether deterministic rule decisions also go to the channel, as one-way
updates rather than decision cards. They are recorded regardless.

> **Ask:** if their rules fire often and the channel gets noisy. `false` keeps the records and the
> activity panel, and stops the messages.

**`remoteControl`**, **`allowedUserIds`**, **`fullMessages`**, **`maxMessageParts`** — see
[`TELEGRAM-SETUP.md`](TELEGRAM-SETUP.md). The one that must be said out loud: **an empty
`allowedUserIds` authorises nobody and the feature does not start.**

Every one of these has an environment fallback — `SESSION_SITTER_TELEGRAM_REMOTE_CONTROL`,
`_ALLOWED_USER_IDS`, `_FULL_MESSAGES`, `_MAX_MESSAGE_PARTS`, `_MAX_TURNS_PER_PASS`,
`_STATUS_HOLD_SECONDS`, `_MIRROR_TOOL_ACTIVITY`, `_TOOL_ACTIVITY_SECONDS` — so a `settings.json` with
none of them is not proof the feature is off. Check with `ss-config.mjs check`, which resolves the
environment too. The allowlist variable splits on commas or whitespace.

`maxMessageParts` is a budget against Telegram's own ceiling of roughly 20 messages a minute to one
group. Past the budget the last message names how many characters were left out and points at
**📄 Full transcript**.

**`maxTurnsPerPass`** is the same ceiling seen from the other side: how many *spoken* turns one pass
may post before the overflow collapses into one line. Every user message and every agent message
that is not a tool call is meant to reach the group, so treat this as a backstop and raise it if a
fast session still collapses.

**`statusHoldSeconds`** — how long a topic keeps the name it has before a status change is written.

> **Ask:** only if they mention Telegram renaming topics constantly. An agent between tool calls
> leaves `working` and comes back seconds later, and each of those was a rename. The default holds a
> name for a minute, never holds `approval`, `question` or `stalled`, and `0` restores the old
> behaviour.

**`mirrorToolActivity`** and **`toolActivitySeconds`** — an occasional `🛠 Edit(src/render.ts)` line,
so a session that is working but not talking is visibly working, sampled at most once per quiet
window rather than streamed.

---

## Knowledge

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.dataRepoPath` | string | `""` | machine-overridable |
| `sessionSitter.knowledge.user` | string | `""` | window |
| `sessionSitter.knowledge.project` | string | `""` | window |
| `sessionSitter.knowledge.team` | string | `""` | window |
| `sessionSitter.knowledge.registryPath` | string | `""` | machine-overridable |
| `sessionSitter.supervisor.knowledgeRepo` | string | `""` | window |
| `sessionSitter.supervisor.knowledgeRef` | string | `"main"` | window |

**`dataRepoPath`** — the corpus repo **root**: the directory containing `data/sessions/` and
`data/knowledge/`. Used by **Upload Session to Corpus** and, unless overridden, as the knowledge
source. Empty falls back to `KNOWLEDGE_LOCAL_REPO`, then `KB_SITTER_LOCAL_REPO`.

> **Ask:** "Do you have a corpus or knowledge repo with your team's practices in it?" If not, skip
> the whole group — supervision runs without knowledge, judging the pending action without written
> practices to weigh it against.

**Never offer the workspace as the source.** The supervised agent can write to the workspace, so
defaulting policy to it would let an agent author the clauses that govern it — the highest-precedence
tier included. The extension has no such fallback by design.

**`knowledge.user`** / **`.project`** / **`.team`** — routing slugs, resolving to
`data/knowledge/{users,projects,teams}/<slug>/bottom-line.md`. Merged **team → project → user**, so
the narrowest scope wins on a conflict. A slug left empty means that tier is simply not configured:
its file is reported missing and the others still load.

`SESSION_SITTER_USER` / `_PROJECT` / `_TEAM` are the terminal's way to route the same three tiers —
read by the **hooks**, which is how a plugin-only install routes its practices. **The extension reads
only the settings**, so setting the variables does not configure an IDE window.

**`knowledge.registryPath`** — optional registry markdown. When set, the triple is validated against
it and the documented fallbacks apply; when empty the three slugs are used as given. Empty falls back
to `KNOWLEDGE_REGISTRY_PATH`.

> **Ask:** only if their team has a registry file. Without one, nothing is validated and nothing
> breaks.

**`supervisor.knowledgeRepo`** / **`.knowledgeRef`** — the git URL and ref, used **only when no local
checkout is configured**. Empty falls back to `KNOWLEDGE_REPO` / `KB_SITTER_KNOWLEDGE_REPO` and
`KNOWLEDGE_REF`.

> **Ask:** prefer `dataRepoPath` and say why: a clone is slower than a local read even with the
> 5-minute in-process cache, and someone editing a local checkout sees the edit on the next decision
> because the local path is three file reads and is deliberately not cached.

---

## Developer

| Setting | Type | Default | Scope |
|---|---|---|---|
| `sessionSitter.debugCommands` | boolean | `false` | window |

**`debugCommands`** — shows twelve developer probe commands in the Command Palette: **Test Bob
Send**, **Test Claude Send**, **Test Claude List Approvals**, and the **Probe …** / **Install …
Hook** / **Capture …** family, which read the agent bridges and print to the Session Sitter output
channel.

> **Ask:** don't, unless they are debugging the extension itself or a maintainer asked them to turn
> it on. They are hidden because typing "Session" in the palette otherwise lists mostly debug
> entries. Nothing about the commands changed — only whether the palette offers them.

---

## Settings that no longer exist

Declared once, read by nothing now, and **silently ignored**. A leftover in a `settings.json` looks
like configuration that is doing something, so it is worth deleting. The doctor reports either as
`removed-key`.

| Key | What replaced it |
|---|---|
| `sessionSitter.uploadScriptPath` | Gone. The uploader is built in — set `sessionSitter.dataRepoPath` to the corpus root. This key is no longer read as a fallback for it. |
| `sessionSitter.pythonPath` | Gone. The supervisor is TypeScript and runs in-process. Reading Bob's SQLite store still shells out to the `python3` on `PATH`, and that was never configurable through this setting. |

Everything renamed in 0.5.0 and 0.6.0 is tabulated in
[`../../CONFIGURATION.md`](../../CONFIGURATION.md#upgrading-to-050) — the old names are **not** read,
so an upgrading configuration needs renaming, and a stale key looks exactly like a feature that does
not work.
