---
name: configuring-session-sitter
description: Set up Session Sitter for a user, or change an existing configuration. Use when someone has just installed the extension, asks how to turn on supervision, Telegram cards or remote control, wants auto-approve rules or workspace colours, asks why a setting is not taking effect, or wants their configuration reviewed. Interviews the user, writes the settings, and validates the result with a script rather than from memory.
---

# Configuring Session Sitter

You are configuring someone's tools. Two things follow from that, and they shape everything below.

**Never guess a setting id.** Run `scripts/ss-config.mjs schema` and read the ids out of the build
in front of you. A setting VS Code does not recognise is silently ignored — no error, no warning,
just a feature that never turns on — so an invented or half-remembered id is the single most
expensive mistake available here. The same script validates a configuration after you write it, and
you report what it says rather than what you believe.

**Ask before you write.** Most of this configuration is preference, some of it costs money per
decision, and one part of it (auto-approve rules) decides what an agent may do while nobody is
watching. Propose, get an answer, then write.

## Start here, every time

```bash
node docs/onboarding/scripts/ss-config.mjs where     # which settings.json is the live one
node docs/onboarding/scripts/ss-config.mjs check     # what is configured now, and what is broken
```

Run both before asking anything. `where` decides which file you are about to edit; `check` tells
you whether this is an onboarding conversation or a repair. If the user has no checkout of this
repo, the script lives wherever they have these docs — the path is the only thing that changes.

`check` exits 0 when there are no errors and 1 when there are. Read its findings back to the user in
plain language before proposing anything: someone who already has a working setup wants to hear what
they have, not a questionnaire from scratch.

### Which file to edit

`where` lists every `settings.json` on the machine, newest first, flagged with whether it already
carries `sessionSitter.*` keys. **Several usually exist and only one is read.** Confirm which one
with the user rather than picking — the wrong file is the commonest reason a change appears to do
nothing.

| Situation | Where the settings live |
|---|---|
| Local VS Code | user settings — `Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)* |
| WSL, SSH remote, IBM Bob IDE | **user** settings on the **client** machine. On WSL with a Windows-side VS Code that is the file under `/mnt/c/Users/<you>/AppData/Roaming/…`, and a Linux-side `~/.config/Code/User/settings.json` from an old native install is never read while looking entirely plausible. |
| One project only | that workspace's `.vscode/settings.json` — but **never** a credential there; those files get committed |

The extension also ships a Settings UI for all of this: **☰ → All settings…** in the panel, or the
**Session Sitter: Open Settings** command. Offer it. Someone who would rather click than have you
edit JSON is right, and the settings are grouped there under the same headings this skill uses.

## The interview

Configuration comes in six layers, and each one only matters if the layer before it does. Walk them
in order and **stop at the layer the user actually wants** — most people want layer 1, and offering
layer 6 to someone who has not turned supervision on wastes their time.

Ask about the next layer only after the current one works. Every layer has a runnable example in
[`examples/`](examples/) that you can read out, adapt, and paste.

| # | Layer | What it gets them | Needs | Example |
|---|---|---|---|---|
| 1 | **The session panel** | The tabbed session list. Sorting, per-project colours, cross-machine sessions. | nothing | [`01-panel-only.json`](examples/01-panel-only.json) |
| 2 | **Auto-respond rules** | Deterministic auto-approve, auto-reject and canned replies. No model, no cost. | nothing | [`02-auto-respond-rules.json`](examples/02-auto-respond-rules.json) |
| 3 | **The AI supervisor** | An agent judges each ambiguous prompt against your written practices. | a state directory · a classifier CLI | [`03-supervisor-stub.json`](examples/03-supervisor-stub.json) |
| 4 | **Telegram cards** | Decision cards on your phone, with a countdown. | a bot · a group | [`04-telegram-cards.json`](examples/04-telegram-cards.json) |
| 5 | **Telegram remote control** | Read and type into sessions from Telegram. | a **forum** group · privacy mode off · an allowlist | [`05-telegram-remote-control.json`](examples/05-telegram-remote-control.json) |
| 6 | **The fast classifier** | ~4-6s decisions instead of ~13.5s, for most ambiguous actions. | a gateway · a token · a model | [`06-fast-classifier-gateway.json`](examples/06-fast-classifier-gateway.json) |

A remote or WSL setup has its own shape across all six —
[`07-remote-and-wsl.json`](examples/07-remote-and-wsl.json).

Full per-setting detail, including everything the layers above do not cover:
[`reference/SETTINGS.md`](reference/SETTINGS.md).

### Layer 1 — the session panel

Ask, in this order. Every answer is optional and the defaults are sensible, so take "leave it" for
an answer and move on.

1. **"Do the rows moving around bother you?"** The default sort is by recent activity, which
   re-orders the list every time any session updates. `hostWorkspace`, `workspace`, `source` and
   `title` hold rows still. `status` puts what needs you first.
2. **"Do you work across several projects at once?"** If yes, offer `workspaceColors`. The
   fastest thing to offer is `{"*": "auto"}` — every project gets its own stable colour, derived
   from its name, with nothing to name by hand.
3. **"More than one machine?"** `remotePeers` is `auto` by default and needs no configuration —
   peers are discovered from the remote windows the IDE has already opened. Offer `off` only if
   they would rather the extension never invoke `ssh`.

### Layer 2 — auto-respond rules

This is the layer to be careful with. A rule decides what an agent may do without asking, so **read
each rule you propose back to the user in words before writing it** — "this approves any read, in
any session, without asking you" — and let them say no.

The shape, both kinds, and the traps are in
[`reference/AUTO-RESPOND.md`](reference/AUTO-RESPOND.md). The three that bite hardest:

- **A rule needs both halves of its pair.** `matchPattern` without `response`, or `toolPattern`
  without `decision`, parses fine, loads fine, and never fires.
- **Bob and Claude have different tool names**, and a rule applies to one agent only — `source`
  is `"bob"` unless you say `"claude"`. `read_file` is Bob; `Read` is Claude.
- **First match wins, per agent.** A `toolPattern: "*"` rule makes every later rule in that same
  `source` unreachable.

Two guards no rule can override, and worth saying out loud so nobody plans around them: a
user-facing question is never auto-approved, and neither is a Claude request whose metadata the hook
missed.

### Layer 3 — the AI supervisor

One setting turns it on: `sessionSitter.supervisorStateDir`. Ask for a writable directory outside any
repo — `~/.ai-sessions/state` is a good suggestion — and note that the extension creates it.

Then two real choices:

- **Which classifier engine.** `bob` (the default) needs a Bob API key; `claude` uses the `claude`
  CLI on the extension host's `PATH`. Ask which agent CLI they actually have. If they say Claude,
  set `sessionSitter.supervisor.engine: "claude"` explicitly — leaving it at the default with no Bob
  key gives a classifier that cannot run, and `check` reports that.
- **Start on the stub channel.** `messagingChannel: "stub"` writes decision cards to files under
  the state directory. Suggest it for the first day: an Orange card nobody receives **times out and
  denies**, which is safe and confusing if they were not expecting it. Reading a few files first is
  how someone learns what the supervisor would have asked them.

Knowledge (the practices the classifier weighs an action against) is optional — with none
configured, it still judges the action, just without your team's written rules. If they want it, ask
for a corpus checkout path plus the user / project / team slugs. **Never offer the workspace as the
knowledge source**: the supervised agent can write to the workspace, so that would let an agent
author the clauses that govern it. The extension deliberately has no such fallback.

### Layers 4 and 5 — Telegram

The settings are the easy part. Four things must be true **in Telegram** first, and every one of
them fails quietly:

1. a **group**, not a channel, with **Topics** enabled (layer 5 only — Topics cannot be enabled in
   a one-to-one chat)
2. the bot's **privacy mode disabled** via `@BotFather` → `/setprivacy` → *Disable*. On by default,
   and with it on the bot sees `/sessions` but **not** the text typed into a session topic: the
   feature looks like it works and ignores everything said to an agent.
3. the bot in the group as an **admin with Manage Topics** (layer 5 only)
4. **one bot per machine.** A bot token has one message stream and reading removes each message from
   it, so two machines sharing a token take each other's messages.

Walk them through it with [`reference/TELEGRAM-SETUP.md`](reference/TELEGRAM-SETUP.md) — it is
ordered so nothing is done twice.

**The bot token does not go in `settings.json`.** Point 4 is why: Settings Sync would copy one
machine's token to every machine, recreating the stolen-messages problem invisibly. Put it in the
environment or a `.env` file. The setting exists and is read first if set — say that, so they know
it is a recommendation and not a limitation.

For remote control, the allowlist is the part people miss: **an empty
`sessionSitter.telegram.allowedUserIds` authorises nobody and the feature does not start.** To find
a user id, turn the feature on with the list empty, send any message in the group, and read the
**Session Sitter** output channel — every rejected sender's id is logged there to copy in.

### Layer 6 — the fast classifier

Say this before configuring anything: **most Claude users cannot use it, and nothing breaks when
they cannot.** A Pro, Max or Team subscription signs in through OAuth with credentials in the OS
keychain and no `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` set, so the tier stays inert and
ambiguous actions go to the agent CLI exactly as before. It applies when someone runs against an API
key or a gateway.

It needs a gateway, a token and a model, and `check` reports `fast-classifier-inert` naming whichever
is missing. It never approves on doubt: a timeout, an HTTP error, an unparsable verdict or a
self-reported confidence below 0.6 all hand the decision down.

## Writing the settings

1. **Read the file first.** Never overwrite a `settings.json` — it holds other extensions'
   configuration, and losing that is worse than any feature you are adding.
2. **Merge, keeping their formatting and comments.** VS Code settings are JSON with comments and
   trailing commas; both are legal and both must survive your edit.
3. **Write only `sessionSitter.*` keys.** Nothing else in that file is yours.
4. **Never write a credential into a workspace file.** `check` reports that as an error, because
   those files get committed.
5. **Say a reload is needed.** Most settings apply live; `Ctrl+Shift+P` → *Developer: Reload
   Window* if something looks stuck.

Then validate, always:

```bash
node docs/onboarding/scripts/ss-config.mjs check
```

Report the findings honestly, including the ones you caused. A configuration that emits a warning
you decided not to mention is worse than one that emits an error you named.

## When something does not work

Do not theorise. `check` finds most of it, and
[`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md) maps each remaining symptom to the
one thing that causes it. The two that come up most often:

- **A setting has no effect** — almost always the wrong `settings.json`, or a typo'd key. Run
  `where`, then `check`; an unrecognised key is reported with the correction named.
- **Nothing appears in Telegram** — token or chat id unresolved (cards silently fall back to the
  stub channel), or privacy mode still on.

The **Session Sitter** output channel (`View → Output`, pick *Session Sitter*) says which source
each value came from and why a feature declined to start. It is the fastest answer to "is it even
reading my configuration", and it beats every guess.

## Environment variables

Every supervisor variable now has a `sessionSitter.*` setting, and a variable applies **only when
the matching setting is unset**. So prefer settings, with two deliberate exceptions: the
credentials, where keeping the value out of a plain-text synced file is the point, and the Claude
Code plugin, whose hooks are bare Node processes with no settings to read at all.

Precedence, highest first — the doctor resolves values this way, so its report and the extension
agree:

1. an explicitly-set `sessionSitter.*` setting (workspace folder > workspace > user)
2. the process environment
3. `<parent of workspace root>/.env`, then `<workspace root>/.env`, then `<workspace root>/.supervisor.env`
4. the built-in default

Note where those `.env` files are read from: the **workspace root**, which is
`sessionSitter.supervisorRepoPath` when set, else derived from an explicitly-set state directory,
else the first workspace folder. Not the home directory.

**Two different questions have two different answers**, and a review that conflates them goes wrong:

- *what does the **extension** read when this setting is blank* — that is what `check` resolves, and
  what a `settings.json` review is asking
- *how does a **terminal** configure this setting* — the daemon, the CLI and the hooks, which have an
  answer for all 42 settings: an environment variable, a flag, or nothing needed because the setting
  configures an IDE surface a terminal does not have

The clearest divergence, and worth saying to anyone who mentions it: **the extension does not read
`STATE_DIR`.** That is the daemon's way to set a state directory. Setting it and leaving
`sessionSitter.supervisorStateDir` blank leaves the supervisor off in every IDE window. The same
applies to `SESSION_SITTER_USER` / `_PROJECT` / `_TEAM`, which the hooks read and the extension does
not.

Both tables are in [`reference/ENVIRONMENT.md`](reference/ENVIRONMENT.md), and
`ss-config.mjs schema` prints them as `envFallbacks` and `headlessOnly`.

## On a machine with no IDE

If the user runs agents anywhere a VS Code window is not always open — a build box, a server, a
laptop they close — mention `session-sitter daemon`. It is configuration-adjacent and easy to miss.

```bash
session-sitter daemon              # resident, 5-second passes
session-sitter daemon --status     # is it running, and is it working?
session-sitter daemon --once       # one pass, for cron
```

**The reason it matters is the timeout.** Expiring an unanswered card is the mechanism behind *silence
is never approval*, and with nothing running an escalated call never reaches its deadline — it sits
awaiting a human for as long as the state directory survives, which is the one outcome this project
says it will not produce. Before the daemon, that ran only inside a VS Code window.

It is configured entirely through the environment, since there is no Settings UI to read: see the
`headlessOnly` table in [`reference/ENVIRONMENT.md`](reference/ENVIRONMENT.md#two-different-questions-two-different-tables).
`STATE_DIR` is the daemon's state directory, `--workspace-root` its repo.

One thing to say rather than let them discover: **it does not apply decisions into a paused agent.**
Reaching a blocked agent's approval prompt means going through another extension's process, which a
terminal cannot do, so the daemon counts the backlog and says a window is needed. Nothing is lost —
the outbox only moves a delivery to `done/` on a confirmed apply, so a window opening later drains the
queue.

Never run `supervise poll --loop` **and** leave `sessionSitter.autoSupervise` on: two consumers of one
bot token each see a random half of the replies, and Telegram answers the second with `409 Conflict`.

## The Claude Code plugin is configured separately

Session Sitter also ships as a Claude Code plugin that governs permission prompts in the terminal,
with no VS Code involved. It shares the practices format and the classifier configuration, and
nothing else: its own knobs are environment variables, because a hook is a bare Node process.

One thing to say before anyone turns it on: **`enforce` mode with no practices file and no
classifier denies every call that is not deterministically safe** — every `Write`, every `Edit`,
every command outside the safe list. That is the design working, and it is not a useful first five
minutes. Start with a practices file, or start in `observe`.

Details: [`reference/PLUGIN.md`](reference/PLUGIN.md) and [`../PLUGIN.md`](../PLUGIN.md).

## Reference

| File | What it holds |
|---|---|
| [`reference/SETTINGS.md`](reference/SETTINGS.md) | every setting: type, default, range, scope, and the question to ask about it |
| [`reference/AUTO-RESPOND.md`](reference/AUTO-RESPOND.md) | the rule format, worked rules, and the ways a rule silently never fires |
| [`reference/TELEGRAM-SETUP.md`](reference/TELEGRAM-SETUP.md) | the Telegram side, in the order that avoids doing anything twice |
| [`reference/ENVIRONMENT.md`](reference/ENVIRONMENT.md) | every variable, what it falls back for, and the ones with no setting |
| [`reference/PLUGIN.md`](reference/PLUGIN.md) | the Claude Code plugin's own configuration |
| [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md) | symptom to cause, with the check that confirms it |
| [`scripts/ss-config.mjs`](scripts/ss-config.mjs) | the doctor: `where`, `schema`, `check` |
| [`scripts/selftest.mjs`](scripts/selftest.mjs) | proves every check in the doctor still fires |

The authoritative documentation this skill is built from, for anything it does not cover:
[`../CONFIGURATION.md`](../CONFIGURATION.md) · [`../SUPERVISION.md`](../SUPERVISION.md) ·
[`../TELEGRAM.md`](../TELEGRAM.md) · [`../KNOWLEDGE.md`](../KNOWLEDGE.md) ·
[`../PLUGIN.md`](../PLUGIN.md)
