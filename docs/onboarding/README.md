# Getting started, with an agent doing the configuring

This folder is an **Agent Skill**: a set of instructions Claude Code, IBM Bob, or any agent that
reads skills follows to configure Session Sitter for you. It interviews you, writes the settings, and
then validates them with a script rather than from memory.

**You do not have to use an agent.** Everything here is readable on its own, and the scripts run by
hand. The skill is a way to make the configuration a conversation instead of a reference lookup.

---

## Use it with an agent

**Claude Code** — from a checkout of this repo, or anywhere you have this folder:

```
Read docs/onboarding/SKILL.md and set up Session Sitter for me.
```

To have it available in every session, copy it into your skills directory:

```bash
mkdir -p ~/.claude/skills/configuring-session-sitter
cp -r docs/onboarding/* ~/.claude/skills/configuring-session-sitter/
```

Then ask for it by name — "use the configuring-session-sitter skill" — or just say what you want:
*"turn on Telegram cards"*, *"why isn't my auto-approve rule firing?"*, *"review my Session Sitter
configuration"*. The skill's description covers all three.

**IBM Bob, or another agent** — point it at [`SKILL.md`](SKILL.md). There is nothing
Claude-specific in it: it is markdown plus two Node scripts.

## Use it by hand

Read [`SKILL.md`](SKILL.md) as a getting-started guide — it is written in the order a configuration
is actually built — and run the doctor yourself:

```bash
node docs/onboarding/scripts/ss-config.mjs where     # which settings.json is the live one
node docs/onboarding/scripts/ss-config.mjs check     # what is configured, and what is broken
node docs/onboarding/scripts/ss-config.mjs schema    # every declared setting, as JSON
```

No dependencies, no network, and it never writes a file. Node 20 or later, which you already have if
the extension is running.

---

## What is in here

| Path | What it is |
|---|---|
| [`SKILL.md`](SKILL.md) | the skill itself: the interview, in six layers, and the rules for writing settings |
| [`examples/`](examples/) | seven complete configurations, one per layer, commented and CI-validated |
| [`reference/SETTINGS.md`](reference/SETTINGS.md) | all 42 settings: type, default, range, scope, and the question to ask about each |
| [`reference/AUTO-RESPOND.md`](reference/AUTO-RESPOND.md) | the auto-approve rule format, worked rules, and the six ways a rule silently never fires |
| [`reference/TELEGRAM-SETUP.md`](reference/TELEGRAM-SETUP.md) | the Telegram side, ordered so nothing is done twice |
| [`reference/ENVIRONMENT.md`](reference/ENVIRONMENT.md) | every variable, what it falls back for, and the ones with no setting behind them |
| [`reference/PLUGIN.md`](reference/PLUGIN.md) | the Claude Code plugin's own configuration |
| [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md) | symptom to cause, with the check that confirms it |
| [`scripts/ss-config.mjs`](scripts/ss-config.mjs) | the doctor: `where`, `schema`, `check` |
| [`scripts/selftest.mjs`](scripts/selftest.mjs) | 36 fixtures proving every check in the doctor still fires |
| [`scripts/snapshot-schema.mjs`](scripts/snapshot-schema.mjs) | regenerates the offline schema snapshot |
| `reference/settings-schema.json` | generated — the doctor's offline fallback |

The six layers, in the order the skill walks them:

| # | Layer | Needs | Example |
|---|---|---|---|
| 1 | the session panel | nothing | [`01-panel-only.json`](examples/01-panel-only.json) |
| 2 | auto-respond rules | nothing | [`02-auto-respond-rules.json`](examples/02-auto-respond-rules.json) |
| 3 | the AI supervisor | a state directory · a classifier CLI | [`03-supervisor-stub.json`](examples/03-supervisor-stub.json) |
| 4 | Telegram cards | a bot · a group | [`04-telegram-cards.json`](examples/04-telegram-cards.json) |
| 5 | Telegram remote control | a forum group · privacy off · an allowlist | [`05-telegram-remote-control.json`](examples/05-telegram-remote-control.json) |
| 6 | the fast classifier | a gateway · a token · a model | [`06-fast-classifier-gateway.json`](examples/06-fast-classifier-gateway.json) |

Plus [`07-remote-and-wsl.json`](examples/07-remote-and-wsl.json), which is the shape a remote or WSL
setup takes across all six.

---

## Why there is a script

An agent configuring your tools has one failure mode that matters: **confidently writing a setting
that does not exist.** VS Code ignores an unrecognised key silently — no error, no warning, just a
feature that never turns on — so a plausible-looking id from an agent's memory produces a
configuration that looks complete and does nothing.

So the skill does not carry a list of settings to trust. `ss-config.mjs` reads
`contributes.configuration` out of the `package.json` of the build in front of you — a repo checkout,
an installed extension, or the committed snapshot as a last resort — and validates against that. A
setting renamed, removed or added shows up the moment the extension changes, without anyone editing a
document.

`check` also resolves settings, `process.env` and the `.env` layers in the same precedence order the
extension uses, so it can answer the question a settings file cannot: *is this feature actually on?*

## How it is kept honest

`ci/check-onboarding.sh` runs on every push and pull request, and again as part of `make guards`:

1. **`selftest.mjs`** drives one fixture per finding code and asserts the code comes back. A check
   that quietly becomes a no-op fails here — otherwise the doctor would report a broken configuration
   as healthy, which is worse than having no doctor.
2. **Every example is re-validated** against the real schema, with the environment its own comments
   tell you to set. An example is offered as something to paste, so a typo in one is a typo in your
   settings.
3. **Every `sessionSitter.*` id named in the prose is checked against `package.json`** — and the
   reverse, so a setting the extension gains and this skill never explains is reported too.
4. **The doctor's environment table is compared against `src/settingsBridge.ts`.** This one is here
   because the drift actually happened mid-review: the bridge gave the four `telegram.*` settings
   environment equivalents, and the doctor went on resolving them from settings alone — so it reported
   remote control as *off* on a machine where the daemon had it on.
5. **The offline snapshot is regenerated and diffed**, because it is committed build output.

Two of those checks assert they can still see their input — "parsed no entries, this check has gone
blind" — because a regex over someone else's source file is exactly the kind of check that passes
forever after quietly matching nothing. Both fired during development, which is the argument for them.

The one thing CI cannot check is whether the *advice* is right. That comes from the documents this
skill is built on, each of which is the authority for its area:
[`../CONFIGURATION.md`](../CONFIGURATION.md) · [`../SUPERVISION.md`](../SUPERVISION.md) ·
[`../TELEGRAM.md`](../TELEGRAM.md) · [`../KNOWLEDGE.md`](../KNOWLEDGE.md) ·
[`../PLUGIN.md`](../PLUGIN.md).
