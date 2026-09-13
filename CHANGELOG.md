# Changelog

This is the one file that names what the project used to be called. Everywhere else carries a
single name — **Session Sitter** — and `ci/check-naming.sh` enforces that.

## Unreleased

### The audit reader's tests stop reading the developer's own state

`src/test/cli/audit.test.ts` opens by declaring its own rule — fixtures rather than a real state dir,
so that it "must pass on a machine that has never run the supervisor, and must not depend on what a
machine that has happens to contain." Two of its tests broke that rule, and failed on any machine
where Session Sitter had actually run.

`resolveState` searches two candidates: one derived from the working directory, which the tests
control, and the VS Code global storage dir, which they did not. `hermeticEnv` cannot reach the
second, because it comes from `os.homedir()` and no environment variable feeds it. So the two tests
asserting *found nothing, anywhere* found the developer's real trail and reported `populated: true`.
CI never saw it: there is no global storage dir on a fresh runner, which is exactly why an
environment-dependent test is worth fixing rather than tolerating.

`os.homedir` is now stubbed to an empty temp tree, per test, alongside the existing `stateDir` and
`dataDir` fixtures — `tmpdir` stays real, since the fixtures live under it. That closes the last
input this file did not control, and it also fixes a third test that had been passing for the wrong
reason: `readFrom` "falls back to the chosen directory" agreed with the expected answer only because
both sides happened to be the developer's global storage path.

No production code changed. Both repaired tests were checked against mutations of the code they
cover — forcing `populated` true, and making `readFrom` name a directory that holds nothing — and
each fails as it should.

### Clicking a side bar session focuses it, instead of duplicating it into the editor

A session living in the secondary side bar was a click that opened a *second* copy of it as an
editor panel in the main area, beside the one already on screen. The three-way split in
`_openClaudeSessionLocal` was right; the fact it consulted was not.

It asked the `claudeCode.preferredLocation` **setting** whether the user's Claude layout is the side
bar. That setting records how Claude was last *asked* to open, not where its view is. Only
`claude-vscode.sidebar.open` ever writes `'sidebar'`, and Claude registers
`claudeVSCodeSidebarSecondary` as a webview view in the `secondarySidebar` container — so revealing
it from VS Code's own UI puts the session on screen while the setting still reads `'panel'`. The side
bar branch was then skipped and control fell through to "no open view here", whose remedy is
`primaryEditor.open`, whose implementation is Claude's `createPanel`. Hence the duplicate.

The window is now asked instead of the settings file. `ClaudeOpenState` carries a third fact next to
`panels` and `states` — `sidebar`, read from the manager's own `sidebarComms`, which Claude sets when
the side bar view resolves and clears when it is disposed. It is true for either container, because
one provider serves both, and it cannot disagree with what is on screen.

Two properties come out of doing it this way:

- **The side bar is aimed at a session, not merely focused.** The former "known limit" — that we
  could focus the side bar but not tell it *which* conversation to show — is gone.
  `revealClaudeSessionInSidebar` drives the manager's `activateInSidebar`, the same entry point
  Claude's own `editor.open` uses when it routes to the side bar, and reveals the view through the
  manager's webview entry rather than a `*.focus` command. That matters: one provider serves two view
  ids, so a view id is a guess, and focusing the wrong one *resolves* it — spawning a second side bar
  instead of revealing the live one.
- **The user's settings are left alone.** The old path's remedy, `claude-vscode.sidebar.open`,
  rewrites `preferredLocation` to `'sidebar'` as a side effect. Switching sessions is not a
  preference change, so it no longer runs.

A regression guard states the bug as its own test: side bar view live, setting reading `'panel'`, and
the click must not reach `primaryEditor.open`. Its mirror is tested too — setting reading `'sidebar'`
with no side bar view resolved must still open by id, rather than aiming at a container that is not
there.

### The team tier becomes reachable, from two machines and not one

`session-sitter learn` could propose a user clause and a project clause but never a team clause, and the
reason was structural rather than a bar set too high: `DecisionRecord` has no user field and one
`dataDir` is one machine and one person, so *"two developers independently do this"* was not a
measurable proposition from a single laptop at any number. That left the tier that binds people who did
not write it as the only tier a human had to write by hand.

`session-sitter learn --publish` makes it measurable, opt-in and per developer. It writes
`<corpus>/data/aggregates/<host>.json` — a shape hash and three counts per shape, for shapes that
cleared the user row on that machine — and stops. It runs no git and sends nothing anywhere; a human
reviews the diff and commits it, in the same repo the clause it supports is reviewed in.

Two properties are load-bearing, and each has a test that fails if it is removed:

- **Per-host counts are cleared, never summed.** Every contributing host must independently clear the
  whole user row before it is a witness at all; 11 occurrences on one laptop plus 1 on another is one
  developer's habit with a witness. The team row then applies to the proposing host's own counts.
- **An aggregate carries counts, never inputs.** The payload is built by naming the four keys it keeps,
  so a command line, a `cwd`, a session name or anyone's prose is *absent* from the bytes rather than
  masked in them. Witnessing hosts ship the unsalted shape hash — verifiable, so a reviewer can
  recompute it from the readable clause — and never a command. `host` is a per-machine pseudonym unless
  you pass `--allow-host-names`.

A team clause proposed this way is `status: proposed` like every other proposal: inert until a human
accepts it. One host publishes one file named for that host, and `ci/check-aggregates.sh` (installed in
the corpus repo) checks both that invariant and that one commit touches one aggregate — which buys
accident prevention and an audit trail, not authentication.


### 0.8.18 — Configuration you can have a conversation about

Thirty-eight settings, six environment-variable groups, and a set of dependencies between them that
nobody discovers in the right order. `docs/CONFIGURATION.md` documents all of it accurately and
answers exactly one question — *what does this setting do* — while the question someone actually has
on the first day is *what should I set*, and the question on the second is *why isn't it working*.

So `docs/onboarding/` is an **Agent Skill**: instructions an agent follows to interview you, write the
settings, and validate them. Six layers, walked in the order they build on each other — the session
panel needs nothing, auto-respond rules need nothing, the supervisor needs a state directory, Telegram
needs a bot, remote control needs a forum group, the fast classifier needs a gateway — so the
conversation stops at the layer you actually wanted instead of touring all of them. It reconfigures an
existing install just as well: *"turn on Telegram cards"*, *"why isn't my rule firing?"*, *"review my
configuration"*.

**The interesting problem was preventing the agent from being confidently wrong.** VS Code ignores an
unrecognised setting key **silently** — no error, no warning, `config.get()` just returns the default —
so an id half-remembered from a doc gives you a configuration that looks complete and does nothing.
That failure is invisible at exactly the moment it is introduced.

A skill that carried a list of settings would be that failure waiting to happen, so it carries a
script instead. `ss-config.mjs` reads `contributes.configuration` out of the `package.json` of the
build in front of you — a repo checkout, an installed extension, or a committed snapshot as a last
resort — and validates against that. Three commands:

- **`where`** lists every `settings.json` on the machine with its modification time and whether it
  already carries `sessionSitter.*` keys. This is first for a reason: on WSL the live user settings are
  on the Windows side under `/mnt/c` while a Linux-side leftover sits there looking equally plausible
  and is never read, and editing the wrong file is the commonest way a change appears to do nothing.
- **`schema`** prints the declared settings as JSON, so the skill never hard-codes an id.
- **`check`** resolves settings, `process.env` and the three `.env` layers in the extension's own
  precedence order, then reports what is on, what is off, and why. It catches an unknown key with the
  correction named, a wrong type, a value outside its enum or range, a credential in a workspace file
  that is probably committed, and every way an `autoRespond` rule silently never fires — half a pair,
  an invalid regex, a rule shadowed by a catch-all **in the same agent's lane**, a scoped Claude
  approval rule (those are skipped, not applied), and a rule aimed at a question tool.

Two of those checks were wrong when first written and were corrected by running the doctor against a
real `settings.json`: an unreachability warning that did not know Bob and Claude rules are matched in
separate lanes, so a `source: "bob"` catch-all appeared to shadow a `source: "claude"` rule it cannot
reach. Which is the argument for `selftest.mjs` — 36 fixtures, one per finding code, asserting the code
comes back. A validation that quietly becomes a no-op reports a broken configuration as healthy, which
is worse than shipping no validator at all.

`ci/check-onboarding.sh` runs the self-test, re-validates all seven shipped example configurations
against the real schema, diffs the generated snapshot, and checks every `sessionSitter.*` id the prose
names against `package.json` — **in both directions**, so a setting the extension gains and the skill
never explains fails the build. That last check found six settings the first draft never mentioned.

It also compares the doctor's environment table against `HEADLESS_EQUIVALENT` in `settingsBridge.ts`,
because that drift happened while this was being written: 0.8.17 gave the four `telegram.*` settings
environment equivalents, and the doctor went on resolving them from settings alone — so it reported
remote control as *off* on a machine where the daemon had it on. The two tables answer genuinely
different questions (*what does the extension read when this is blank* versus *how does a terminal
configure this*, where `STATE_DIR` is the sharpest divergence: the daemon reads it and the extension
never does), so the check asserts the one relationship that must hold rather than equality.

Two checks assert they can still **see** their input — "parsed no entries, this check has gone blind" —
because a regex over another file's source is exactly the kind of check that passes forever after
quietly matching nothing. Both fired during development, which is why they are there.

Nothing ships in the `.vsix`: `docs/` is already excluded.

### 0.8.17 — `/new` started a session you could not continue from Telegram

`/new` opened a Claude panel and reported that the session's topic would appear "once it writes its
first message". Nothing ever wrote one. **A panel nobody has spoken to writes no transcript**, and the
worklist is built from transcripts — so the session was visible in the IDE, absent from the session
list, had no topic, and could not be continued from the phone it was started on. The promise in the
report was never kept because nothing was ever going to keep it.

Two facts made it fixable, and neither was being used. **A fresh panel does have a session id** —
Claude's live manager (`sessionPanels`) knows it immediately, which `getOpenClaudeSessionIds` already
reads. And **`BusResult.sessionId` already existed** for exactly this, documented as "set by
`newSession` once the started session is identified", with nothing setting it and nothing reading it.
The plumbing had been designed and left unfinished.

So `/new` now reads the open panels *before* opening, opens, waits briefly for exactly one new id to
appear, **sends that session a first message** — which is what makes the CLI write a transcript and the
session real — and hands the id back so its topic is created there and then instead of waited for.

Where it cannot be sure it says so rather than guessing: two sessions appearing at once is a refusal to
pick (a first message in the wrong conversation is worse than none), nothing registering within 8s
leaves the panel open and unnamed, and a first message that does not land still gets a topic with the
reason quoted. **None of those is reported as "could not start"** — the panel is open in every one of
them, and saying otherwise sends someone looking for a window sitting in front of them. Bob is
unchanged and still unconfirmable: `startTask` returns nothing.

**And a session could open in a workspace you did not pick.** The menu paired each folder with
*whichever window listed it first*, so a multi-root window listed early captured folders that had a
dedicated window of their own — and tapping one opened a panel in the multi-root window, where Claude
chose the folder itself. Nothing in Claude's API takes a folder (`primaryEditor.open` accepts a session
id and nothing else), so the only way to be certain is to open in a window that has no other folder to
choose from. `chooseLaunchTarget` prefers exactly that, tie-breaking on lowest pid so every window
reaches the same answer.

Where no single-folder window exists the folder is still offered — it is startable, just not guaranteed
— with the caveat printed in the menu, naming the other folders it could land in. Said **before** the
tap, because once the session exists in the wrong folder the only remedy is to close it and start
again, which costs the round trip the warning would have saved. Guessing an undocumented option name
for the command would have been worse than naming the part that is not ours to decide.

### 0.8.16 — On a machine with no VS Code, nothing owned anything

Session ownership had three tiers, and the first two both resolve to a **VS Code window**: one that
holds the session, or one whose workspace contains it. On a machine with no window at all, both find
nothing and every session fell to tier three — *nobody*, read-only. So a terminal-only fleet could be
neither listed as owned nor acted on, which is the assumption the whole remote interface was built on
and the one a terminal breaks.

`session-sitter daemon` is now a claimant, below both window tiers. Below, and not because a window is
more trustworthy: a window can do strictly **more**. Claiming first would take a session that could be
answered from a phone and hand it to an owner that can only watch.

**Owning a session is not the same as being able to write to it**, and that is now explicit rather than
assumed. `canInject` is a separate question from `basis`, because injecting text goes through the
agent's own extension host over the V8 inspector — which exists only inside VS Code. The daemon can be
responsible for a session, mirror it, answer the permission prompts it raises through hook escalation,
and still be unable to type into it.

Conflating those would have the remote interface offer a button that silently does nothing, against a
feature whose stated rule is that it never writes to a session it cannot positively reach and says why
where it cannot. So `applyCommand` refuses `sendText`, `focus` and `newSession` **before** calling any
sender, with a sentence that names the fix ("open the session in an IDE window"). Checking first rather
than letting a sender fail matters: the senders' own failures are `no-channel` and `ambiguous`, which
describe a window that could not find the right conversation — a different problem with a different
fix, and reporting one as the other sends someone hunting for a session that was never reachable from
here at all.

A daemon claims only while its heartbeat reads `running`. A wedged one would take sessions off the
read-only tier and then fail to serve them, and the list would say somebody had.

**`session-sitter status --owners`** makes the model observable, and observable from a terminal:

```
   STATUS    SESSION                 AGENT   WORKSPACE       OWNER         UPDATED
!  approval  bump the pinned deps    Claude  infra           daemon 9001        2m
◉  finished  add the retry test      Claude  session-sitter  window 33550       1d
·  dormant   an old experiment       Codex   scratch         read-only          6d
```

Resolved by exactly the code the panel uses, from files on disk — the window registry and the
heartbeat — so a terminal reaches the same answer without being an IDE. Sharing the resolver rather
than reimplementing it is the point: two surfaces disagreeing about who holds a session is worse than
either being wrong, because then neither can be trusted. `--json` reports `owner.canWrite` rather than
leaving each caller to infer it from `basis`, and the key is **absent** without `--owners` rather than
null — absent means nobody looked, and null means nothing claims it.

The Telegram topic header and the `/who` listing now name a daemon owner as a daemon. Calling it a
"window" would tell a reader they can type there, which is the one thing they cannot do.

**Not in this change, and worth being plain about:** the daemon does not yet *run* the Telegram mirror.
That needs a host-free session partition — `RemoteControlService` takes a `SessionManager` and asks the
panel which sessions are active — and porting that is a larger piece than the ownership model. What
landed is the model, the capability distinction, the refusals, and one surface that uses all three.

### 0.8.15 — Half the settings could not be set without VS Code, and nothing said so

The `supervisor.*` group has layered settings over the environment for a long time, so a headless run
could configure 19 of the 38 settings. The other 19 had no headless story at all — and, worse, no way
to notice. A setting the extension reads and a terminal cannot is invisible until someone on a build
box asks why their configuration does nothing.

`src/settingsBridge.ts` now names the answer for **every** setting, and `ci/check-settings.mjs`
compares that table against `package.json` in both directions. Declaring a setting without deciding how
a headless run configures it now fails CI rather than shipping.

**Three kinds of answer, because there are genuinely three.** The honest question is not "does every
setting have an environment variable" — it is "can a person with no IDE configure this":

- **`env`** — a variable, read from the environment or a `.env`. The four `telegram.*` settings had
  none, which is the concrete gap this closes: the daemon can hold the reader lease and mirror
  sessions, and until now there was no way to tell it to.
- **`flag`** — where the setting is *consent* to something with a side effect. `--peers` opens SSH
  connections, and a flag typed at the moment of use is a clearer consent than a variable inherited
  from a shell profile. `session-sitter daemon` also gains `--workspace-root`, which is what makes
  `supervisorRepoPath` genuinely reachable — for a service the working directory comes from a unit
  file, not a shell.
- **`ide`** — it configures the IDE surface and there is nothing headless to change. Each of the seven
  carries its reason, because "no equivalent needed" is a claim, and an unexplained one is how a real
  gap gets filed under this heading and forgotten. A `workspaceColors` variable would be a knob wired
  to nothing, which is worse than its absence: it implies the terminal has a panel to colour.

Precedence is unchanged and now uniform: an explicitly-set setting wins, otherwise the environment,
otherwise the declared default. On the VS Code side that needs `inspect()` rather than `get()` —
`get()` returns the manifest default for an unset setting, so an environment layer beneath it would be
unreachable for every setting that has one, which is all four of the new ones.

**Two bugs found by writing the guard, which is the argument for having it.**

Three of the environment names in the first draft of the table were wrong: `BOB_CLI` for
`BOB_CLI_PATH`, `CLAUDE_CLI` for `CLAUDE_CLI_PATH`, and a `CLASSIFIER_TIMEOUT_SECONDS` that has always
been `CLAUDE_TIMEOUT_SECONDS`. So the guard checks each name against the source and the documentation
rather than trusting the table: **a variable nobody reads is worse than none, because someone sets it
and watches it do nothing.**

And the first version of that name check was **vacuous.** It included `src/settingsBridge.ts` among the
files searched — but the bridge reads variables *through* the table, so its own source contains every
name the table holds, including a wrong one. Verified by planting a deliberately bogus name and
watching the guard pass; evidence now has to come from somewhere the table did not write.

One more thing the existing guard caught, exactly as designed: the first refactor passed the setting
key through as a variable instead of a literal, which made all four `telegram.*` settings look unread
and failed check 3. The literals are back, with a comment saying why they have to stay.

### 0.8.14 — Rung 7 can ask a human now, and the hook holds the prompt open to do it

Rung 7 had one answer: deny. Correct, and for a terminal session over SSH it was the *only* answer —
there was no way for a person who was not at that terminal to say yes. `SESSION_SITTER_ESCALATE=on`
adds one, and rung 7 becomes *ask a human, then fail closed.*

**The prompt is held open rather than typed into, and that is the design.** The obvious way to answer a
terminal session from a phone is to write into it — find the process, inject the keystrokes. This
project has that machinery for the IDE (`ClaudeSender` reaches into the `anthropic.claude-code`
extension host over the V8 inspector) and it cannot work for a bare `claude` in a terminal, which has
no extension host to reach into. Inverting it is better, not merely available: `PermissionRequest` is
**already** the synchronous decision point and is allowed 60 seconds, so nothing needs to write into
the session at all. What comes back is a real permission decision that can cite a clause, rather than
simulated typing, and it works identically in a tmux pane, over SSH, or in an IDE.

**The hook never touches the messaging channel.** A bot token has one update stream and `getUpdates`
consumes it destructively — and a hook runs *once per prompt*, so a hook that polled Telegram would be
an unbounded number of competing readers, far worse than the two-window case the reader lease exists to
prevent. So the hook writes an **ask** to a file and polls for a **verdict** beside it; the daemon is
the single reader that posts it, correlates the reply and writes the verdict. The ask is promoted into
an ordinary supervision record for that, which is what keeps it inside the *same* `pollResponses` call
as every other pending decision — a second call would have consumed updates meant for the first, inside
one process.

**It refuses to wait for something nobody will answer.** With no daemon running, the ask cannot be
delivered, so the hook denies immediately and names the command that fixes it rather than holding the
agent still for 45 seconds first. A wedged daemon counts as none — it cannot deliver an ask either, and
"the pid exists" is not the question. That is what the heartbeat's `stale` verdict is for.

**A real safety bug found and fixed on the way.** `Orchestrator.replyApproves` approved on *any*
approval word anywhere in the reply — so **"no, don't allow that" approved the call**, because it
contains `allow`. Survivable while it only resolved Bob approvals; not survivable once a permission
decision rides on the same parser. It now requires an approval word **and** no negation word.
Requiring *every* word to be an approval was the other obvious fix and is worse — it rejects "yes
please" and "ok go ahead", which is how people actually answer. There is still exactly one definition
of "what counts as approval", and the escalation path deliberately does not add a second.

Two things it will not do, both deliberate:

- **One answer never becomes policy.** An escalated allow is not `settled`, so no standing permission
  rule is derived from it even with `SESSION_SITTER_PERSIST_RULES=on`.
- **Silence is still never approval.** The deadline passing is a denial, recorded with `actor: 'timeout'`
  and a note saying a human was asked and did not answer.

The wait is capped at 55s, below the event's own 60s budget, because a hook killed mid-wait returns no
JSON at all — which Claude Code reports as a hook *error* rather than as a decision, and a governance
layer whose failure mode is "no verdict" is not one.

The heartbeat moved into `src/daemonHeartbeat.ts` so the hook can read it without importing the
daemon. That import would have dragged the orchestrator, the supervisor factory, the Telegram client
and the window registry into the closure of **every permission prompt**, to call three functions that
read one small JSON file.

### 0.8.13 — Nothing was expiring an escalation on a machine with no IDE

*Silence is never approval* is this project's founding rule, and the mechanism behind it is a card
expiring at its deadline. That mechanism ran in exactly two places: inside a VS Code window, or as
`supervise poll --loop` typed by hand. On a terminal-only machine, neither. An escalated call did not
fail closed at its deadline — it sat in `orange_awaiting_user` for as long as the state dir survived,
which is the one outcome the rule says will not happen.

`session-sitter daemon` is that loop as something you can leave on: correlate replies to escalations,
and expire the ones nobody answered. `--once` for cron, `--status` for whether it is actually working,
and a user systemd unit at `plugin/systemd/session-sitter-daemon.service`.

**It is deliberately not "the extension's services, headless."** Most of that loop could not be lifted
out, because on a terminal-only machine *its input does not exist*: `SupervisionService`,
`AutoResponder` and `PendingWatcher` are all driven by IBM Bob's pending-approval queue, read through
the VS Code extension host, and Bob is an IDE. A daemon that constructed them would be watching an
empty room. Two jobs were genuinely homeless, and those are the two it does.

**It does not apply decisions, and says so.** Reaching a paused agent means resolving a prompt through
that agent's approval emitter, inside another VS Code extension's process — a terminal cannot get
there. So the daemon counts the outbox backlog and reports that a window is needed, leaving every
delivery where it is. The outbox moves a delivery to `done/` only on a confirmed apply, so a window
opening later drains it; a daemon that discarded what it could not deliver would be worse than one
that never ran.

**One reader per machine, enforced rather than documented.** A bot token has one update stream and
`getUpdates` consumes it destructively — two pollers split the replies at random and both look like
they are working. The daemon takes the same `ReaderLease` the Telegram remote control uses and reads
only while it holds it. Not holding it is not an error: a window is the reader, and it is already
doing this work. What still runs in that state is **timeouts** — suppressing reads must never suppress
expiry, or standing down would leave escalations pending past their deadline. Getting this right
needed a channel wrapper, because `Orchestrator.poll()` reads replies and applies timeouts in one call
and holds its channel privately: taking the lease without gating the read would have consumed the
stream either way, and the lease would have been decoration.

It also refuses to start when a live extension host is registered here, naming the pids. The lease
alone cannot cover that case — with the remote interface off, `SupervisionService` polls Telegram
*without* taking it, so nothing would arbitrate. `--allow-with-ide` is the override.

**`--status` answers a question `systemctl status` cannot.** A pid does not say whether timeouts are
being applied: pids are recycled, and a daemon wedged mid-pass is still a live pid and still
`active (running)` to systemd. So every pass writes a heartbeat, and the status reads `running`,
`stale` — *the process is up and the work has stopped*, in as many words — `dead`, or `single pass` for
a finished `--once` run. That last one exists because reporting a working cron setup as `dead` with
"nothing is applying timeouts" is a status line crying wolf, and those are the ones people stop
reading. Staleness scales with `--interval`, so a ten-minute daemon is not called wedged for being
nine minutes idle.

A failed pass is logged and the loop continues — the point is to still be running in an hour, and a
transient error inside a Telegram read is the likeliest thing to go wrong. `SIGINT`/`SIGTERM` finish
the pass in flight, release the lease and exit 0.

### 0.8.12 — The plugin was the one way in that did not get the CLI

`docs/CLI.md` describes `session-sitter` as the front end for "people who never open the IDE", and the
plugin — the way those people install this — shipped `audit/cli.js` and `policy/cli.js` and nothing
else. So `log` and `policy check` worked from a slash command, and `status --watch`, `export --html`
and `learn` existed only for someone who had cloned the repository. That is the opposite of the
audience.

`cli/index.js` is now in the plugin's build closure, which is derived rather than maintained: the
whole `session-sitter` command and every module it requires, with the no-`vscode` invariant enforced on
the way in as it is for the hooks. The slash commands point at it, so the terminal and the slash
command can no longer disagree about what `log` means. `/session-sitter:learn` and
`/session-sitter:export` are new, and `/session-sitter:status` now answers both of the questions it
was being asked — the worklist from each agent's own store, and what the hooks have registered, which
is the one that says whether governance is wired up at all. A session in the first list and not the
second is running ungoverned.

**A wall-clock timestamp nearly broke every CI run.** `cli/index.js` requires `buildInfo`, whose
`BUILD_TIME` is stamped at compile time — and `plugin/lib/` is committed build output that
`ci/check-plugin-lib.sh` verifies by rebuilding and diffing. CI compiles before it checks, so the
rebuilt file would differ from the committed one on every single run, and the freshness guard would
fail for a reason that has nothing to do with freshness. The fix is not a workaround but the more
honest value: **a plugin is not built.** It is a git ref cloned into `~/.claude/plugins/cache/`, so
there is no build for a build time to describe, and a timestamp there would name the moment some
maintainer happened to run `make plugin`. The shipped `BUILD_TIME` is empty and `--version` prints the
clause only when it has one. The build script fails loudly if the generated file's shape ever stops
matching what it rewrites, because a silent no-op there would put CI back to failing every run.

**The plugin manifest's version had drifted five patch releases behind** `package.json` — 0.8.0
against 0.8.11 — because nothing read the two together. It is what names the directory an install is
cloned into, and now that the version is baked into the shipped tree, a manifest claiming a different
one makes `session-sitter --version` disagree with the plugin you installed. `ci/check-naming.sh`
compares them.

**On PATH, three ways, none of them needing VS Code.** `plugin/bin/session-sitter` is a launcher to
symlink; it resolves its own symlinks, so when a plugin update makes the version-stamped link stale it
says which path it resolved to and prints the re-link command instead of failing with a Node module
error. Separately, `npx github:eranra/session-sitter` and `npm i -g github:eranra/session-sitter` now
work: a `prepare` script builds `out/` on the way in, and a `.npmignore` keeps the tarball to the
command — 444 kB against the 15 MB it started at, once the screenshots were excluded properly.
(`.npmignore` and not a `files` array: **vsce refuses to run when both `.vscodeignore` and `files` are
present**, so `files` would have broken the .vsix. The two packagings stay independent, which is worth
having — they ship different things.)

New tests spawn the shipped tree in a bare `node`, because the existing guard diffs bytes and a
missing module is invisible to a byte diff — it shows up for the first time as a stack trace in front
of a user at a permission prompt. They also assert every script a slash command runs exists in
`plugin/lib` and is declared in `allowed-tools`, which nothing caught before: the manifest validates,
the tree diffs clean, the tests pass, and the command fails the first time someone types it.

### 0.8.11 — `log` could not see the trail the hooks had been writing all along

On a machine with no VS Code, the plugin's hooks are the only front end running, and
`decisions.jsonl` is the only governance record there is. `session-sitter log` did not read it. Nor
did `digest`, nor `policy check --replay`. All three answered:

```
No supervision state found. Looked in:
  /home/u/repo/.supervisor-state
  /home/u/.config/Code/User/globalStorage/eranra.session-sitter/state
```

— on machines that had been recording every decision for weeks. Two things were wrong at once. The
hooks write `<dataDir>/decisions.jsonl`, where `dataDir` is `$CLAUDE_PLUGIN_DATA` or
`~/.claude/session-sitter`; the readers looked for `<stateDir>/audit.jsonl`. **Different directory,
different filename** — and nothing in the repository writes `audit.jsonl` at all, so the writer the
reader was built around did not exist yet. `export` had been reading the hook trail correctly the
whole time, which is why the gap survived: two of the five commands worked.

The fix reads the hook trail **as well as** the state dir, not as another candidate for it. Those are
different kinds of store in different places, and a machine can have both — an IDE window supervising
sessions, and terminal sessions governed by the same practices. Picking one and hiding the other is
the worst failure available to an evidence tool.

`decisions.jsonl` is a different shape from `audit.jsonl`, not a differently-spelled one, and every
difference is resolved by recording what the writer knew:

- a rewrite is stored as `decision: "allow"` with `rewritten: true`, and reads as outcome
  **`correct`** — the correction lane is the distinction this trail exists to make;
- `decision: "none"` means the hook reached no verdict, and reads as **`unknown`**, never `allow`. A
  layer that records a decision it did not take is a layer whose trail cannot be used as evidence;
- `actor` keeps the rung that answered (`deterministic`, `policy`, `correction`) rather than being
  flattened to `rule`. Only `model` is translated, to `classifier`, so all three writers use one word
  for "a model decided this";
- no `host`, no session name, no cost. The hook records token counts, and turning those into money
  inside a reader would mean pinning prices where nobody could trace them.

`--state-dir` is unchanged and now documented as what it always was: one directory and nothing else,
the hook trail excluded. Being told where to look and reading somewhere else as well is not a favour
either.

Every command already named the directory it read; that line now names what it **actually** read,
both stores when both are in play. It was misreporting in the new case — decisions from the hook trail
printed under a state dir path that need not even exist. `log --json` and `digest --json` gain
`hookTrail` additively; `stateDir` keeps its meaning and its key.

### 0.8.10 — The mirror was showing you 250 characters of the answer

Telegram topics mirrored a session's turns, and the turns arrived cut off. Not at Telegram's
4096-character message cap, which would at least have been most of an answer — at **250 characters**,
because the mirror was reading `getRecentExchanges`, the function written for the preview bubbles the
Sessions panel draws beside each session. 250 characters is a good preview when the session is on
screen next to it. It is unusable as the only thing you can see of an answer you have to reply to,
and the part you need is almost always the end.

Three losses were stacked, and only the last was Telegram's:

- the reader capped assistant text at 250 characters and user text at 150,
- it took only the **first** text block of a message, so an answer written around a tool call came
  back as its opening sentence, and
- the renderer then truncated whatever survived at 4096.

So `getRecentExchanges` grew a `full` option: no caps, every text block joined, and a tail read
widened from 32 KB to 1 MB — because a record larger than the window is not truncated but *lost*, the
read starting mid-line and the JSON no longer parsing. The panel and `AutoResponder` call it without
the option and are unchanged to the character.

A long turn is now **split** across messages rather than cut, numbered `(1/3)`, `(2/3)`, `(3/3)`, on
paragraph, line or word boundaries. `sessionSitter.telegram.fullMessages` turns this on and **is on
by default**; `sessionSitter.telegram.maxMessageParts` is the budget, 4 by default and 20 at most.
Past the budget the last message names the exact number of characters left out and points at
**📄 Full transcript**.

The ceiling is Telegram's own: about 20 messages a minute to one group. Splitting and the
four-turns-per-pass cap pull against each other — four turns at four parts each is most of a minute's
allowance — so the budget is not shared out evenly. **The newest turn of a pass gets all of it and
the earlier ones get one message each**, because the last turn is the one being answered and the
ones before it are context you skim. Worst case per pass is three messages plus the budget.

One thing that quietly stops being broken: echo suppression, which keeps a prompt sent from Telegram
from being posted back as a duplicate, compares the sent text against the transcript's. A prompt over
150 characters was read back truncated, failed the match, and came back. The comparison also moved
into `planMirror`, ahead of splitting, so a prompt long enough to be split is still recognised.

### 0.8.9 — A window can be alive with nobody in it

0.8.8 stopped a closed window's finished sessions from sitting in the worklist forever, by making a
probe report expire. This adds the sharper signal it was standing in for: when someone was last
actually at the window.

Every liveness test the registry has answers "is the publisher still running". On a remote IDE that
is the wrong question. The publisher is the **server-side** extension host, and closing the client
window does not stop it — the server keeps it warm for a reconnect that may never come, so it goes on
naming the tabs that were open when you disconnected. `process.kill` says yes, truthfully, to a
window nobody can see.

So a window entry now carries `lastActiveAt` alongside `updatedAt`. `updatedAt` says the publisher
is running; `lastActiveAt` says a person was here, taken from `vscode.window.state` and stamped only
while the window reports itself interacted with. `sessionSitter.windowAttentionMinutes` then bounds
how long that report keeps counting, and a window past the bound stops vouching for its tabs. The
sessions fall back to the same rules that already cover a window with no probe at all — so a
`working` session still survives on recency, and one blocked on your approval still never ages out.

**It ships off, at `0`.** The premise underneath it is a claim about the extension host, not about
this code: whether a host that has lost its client really does stop reporting itself active is not
something the panel can check from the inside. Shipping the signal inert makes it measurable — the
field is published and readable on a peer — without hiding a session on an unverified guess. Two
things fail open for the same reason: a zero window disables the rule outright, and an entry carrying
no stamp at all counts as attended, so a peer running an older build behaves exactly as it does today.

### 0.8.8 — An open tab is not work in progress

A session that had finished hours earlier sat at the top of the worklist, on a machine whose IDE
window had been closed. The rule was doing what it said: a window reporting a tab open settled the
question outright, at any age.

That report is honest, and it answers the wrong question. It says the tab exists, not that anything
is happening in it. On a remote IDE the two come apart badly. The process that publishes the window
entry is the **server-side** extension host, and closing the client window does not kill it — the
server keeps it warm for a reconnect that may never come. So it stays alive by `process.kill`, keeps
refreshing its entry every 60 seconds, and keeps naming the tabs that were open when you
disconnected. Every liveness gate the registry and the peer probe apply passes truthfully. Observed:
an extension host 2 h 38 m old, its entry rewritten 6 seconds before it was read, no client attached
to the server at all.

So a probe report and recency now back each other up instead of either one deciding alone. A
`working` session counts if a window reports it open **or** its transcript is recent — that half is
unchanged, and it is what keeps a session you are sitting in from vanishing during a probe hiccup.
Anything past `working` needs both. Blocked on you is still exempt from every bound there is: that
row is stuck, not stale, and hiding it is the one failure that costs you something.

The bound is the two hours already in `STALE_FALLBACK_WINDOW_MS`, not a second knob. Both halves are
covering for the same weakness from opposite sides, and one number is easier to reason about than
two that must be kept in a sensible relation to each other.

One cost, stated plainly: a finished session in a tab you have open but have not touched for two
hours now moves to History. That is the trade. The panel and Telegram both read this one rule, so
they still agree about the fleet.

### 0.8.7 — The working ring turns again

The `working` spinner was standing still on any machine with Windows animation effects switched off,
and it was this panel's own stylesheet doing it. `@media (prefers-reduced-motion: reduce)` set
`animation: none` on `.status-working` and filled in the ring's transparent top segment, so the
marker rendered as a complete, static green circle — the one state in the set that is supposed to
move, looking permanently like a state that never does.

Windows drives that media query from a single switch: **Settings → Accessibility → Visual effects →
Animation effects**. Off, and `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)` returns 0, which
Chromium reports as `reduce` for every page it renders — including a VS Code webview, and including
one whose workspace lives in WSL, because the editor's renderer is a Windows process. Nothing about
the panel looked broken from the inside; the rule was doing exactly what it said.

The carve-out is gone and the ring now turns unconditionally. The turning is the signal, not
decoration: a stopped ring carries nothing the other five silhouettes do not carry better, so
stopping it did not degrade the marker gracefully — it erased the difference between "busy right
now" and "sitting there". The test that used to require the spinner be stopped now requires the
opposite, and says why, so the rule cannot come back by accident.

This is unrelated to the phase-anchoring fix in 0.8.4's predecessor, which was correct. A negative
`animation-delay` cannot rescue an animation that was switched off before it started.

### 0.8.6 — Reach the topics the cleanup could not see

0.8.4 made a session's topic get **deleted** when the session leaves the active list, and that works.
What it could not do was see a topic whose record was gone, and a real group still filled up with
leftover threads for exactly that reason.

Every pass works from the record store, one file per topic under
`~/.claude/session-sitter/bus/topics/`. That store is the *only* handle on a topic, because the Bot
API has no call that lists a group's topics — `getForumTopics` is a user-API method and
[says so](https://core.telegram.org/method/channels.getForumTopics): "Only users can use this
method". A bot can delete a thread whose id it knows and can learn an id from a message sent in one.
It cannot ask what is there. So a topic with no record is not merely unpruned — it is invisible, and
nothing will ever remove it.

Three changes:

- **A record that cannot be read no longer hides its topic.** `TopicStore.all()` skips a file it
  cannot parse, which is correct for every caller that needs a session mapping and exactly wrong for
  pruning. The filename is the thread id, which is all a delete needs, so `damagedThreadIds()`
  reports those and the pruning pass removes the thread and the unreadable file together. Only a file
  that reads cleanly and still fails to parse counts — a read that throws is far more likely to be
  this store's own `rename` landing mid-scan, and treating that as a lost topic would delete a live
  session's thread.
- **A failed record write no longer strands a topic.** `createTopicFor` created the topic in Telegram
  and then saved the record; a failure in between left a thread nothing owned, permanently. The topic
  is now deleted again if its record cannot be written, because a topic that cannot be recorded is
  worse than no topic.
- **`/forget` deletes the topic it is sent in.** The only way to reach a thread whose record was
  already gone — deleted by hand, lost with the `bus/` directory, or created before the store
  existed. A message carries its `message_thread_id`, so typing in the thread is the one thing that
  still identifies it. An active session's topic is refused rather than deleted, since it would come
  straight back on the next pass.

For `/forget` to arrive at all, a slash command now routes to remote control **wherever** it was
typed. It previously reached remote control only from General, so a command sent inside a thread the
store did not recognise went to the supervision channel, which has no concept of a topic — which
threw away the one signal capable of finding these threads. `/sessions` typed in a topic used to
vanish for the same reason.

One thing worth knowing, now written down in `docs/TELEGRAM.md`: the store is keyed to the extension
host's home directory. A WSL-remote window and a Windows-local window on one machine keep separate
stores, as does every other machine in the fleet. Each prunes what it created, so a topic created by
a host that never runs again is one nothing cleans up, and it wants `/forget` too.

### 0.8.5 — A message from Telegram finds its own Claude session

Sending to a Claude session from Telegram answered `Its window has 2 Claude sessions open and this
build cannot tell them apart, so nothing was sent.` — reliably, for anyone who works with more than
one Claude tab. The refusal was correct; the reason for it was not.

`buildTargetedInjectFn` looked for the session id **on the channel**: the channel map key, the
channel's own scalar properties, `query.initConfig`. It is on none of them. Claude builds a channel as
`{in, query, pid, resolvePid, vscodeMcpServer, mcpServers, …}` and keys it by a `channelId` its webview
invents, so the search could not succeed on any build. One session open worked only because of the
sole-channel fallback; two never worked at all.

The link does exist, and it runs through the surface showing the session — by object identity, not by
name:

- `sessionPanels: Map<sessionId, WebviewPanel>` gives the tab. It is self-pruning, and setting a
  session on a panel deletes that panel's previous entry, so one panel means one session.
- `sessionStates: Map<sessionId, {info, author}>` gives the authoring surface when there is no panel
  entry — the panel for a tab, the comm object itself for the sidebar. Claude prunes its own state by
  that same identity.
- A comm stores the panel it hosts as `panelTab`.

Chaining those gives sessionId → surface → comm → that comm's channel. Two tabs are now two comms with
one channel each, and each message lands in its own session: status `ok:owner`. The old id search still
runs, narrowed to the owning comm, so a future Claude build that does expose the id keeps working.

What still refuses, and why:

- **One surface has shown several sessions.** `sessionStates` accumulates — an entry goes when its
  surface is disposed, not when the surface switches session — so several ids can name one author while
  only one is live. Nothing in the manager says which, so the route declines rather than pick. The
  message now says to focus the session and send again, which is the action that fixes it.
- **Two comms claiming one surface**, and **a session with no channel at all**. Same refusal, same
  reason: delivering a prompt to the wrong agent is worse than not delivering it.

Checked against every Claude Code build installed here (2.1.237 through 2.1.241). `panelTab` and
`sessionPanels` are present in all of them, so tabs resolve on all of them. `author` arrived in
2.1.238 — 2.1.237 stores a flat `{sessionId, state, title}` with no owner — so on that one build a
sidebar session has no ownership link and falls back to the previous behaviour.

Two things make the new route safe to depend on:

- **Identity, not field names.** A comm is matched against the owning surface through *every* own
  property, not just `panelTab`. A rename in a Claude release costs targeting and falls back to
  refusing; it cannot start sending to the wrong session.
- **A probe that runs the real code.** `sessionSitter.probeClaudeTargeting` ("Probe Claude Targeting")
  reports, per session, which channel a message would land in and by which step — writing nothing. It
  shares the resolution snippet with the sender, so it reports the decision rather than a second
  implementation's opinion of it. After a Claude Code update, that command is the check.

### 0.8.4 — Telegram shows the active sessions, and nothing else

A dead session's topic was **closed**, and closing does not remove it. Telegram keeps a closed topic
in the group's topic list — locked, greyed, and fully visible — so the cleanup that was supposed to
keep the group equal to the worklist did nothing a user could see. A real install had 46 topic
records: 43 correctly marked closed, and all 43 still sitting in the sidebar. The one thing the
feature was meant to prevent had happened anyway.

Topics are now **deleted** when their session leaves the active list. `ForumApi.deleteTopic` calls
`deleteForumTopic` and the record is dropped, so the group's topic list is the active list. Nothing
that matters is lost: the transcript on disk was always the source of truth, and `/history` builds a
fresh topic from it.

Two details this depended on:

- **Already-closed records are selected too.** `topicsToDelete` no longer skips `closed` topics, the
  way the old `topicsToPrune` did. Every install carries a pile of them from this version's
  predecessor, and passing over those would have left the 43 dead threads there for good — the
  upgrade would have fixed nothing.
- **A topic already gone is not a failure.** `isTopicGoneError` tells "message thread not found"
  apart from "not enough rights", so a topic you deleted by hand in the app has its record dropped
  instead of being retried on every pass forever. A genuine permission failure keeps the record,
  falls back to closing the topic, and says why in the Output log — the bot needs `can_manage_topics`.

The empty-fleet guard is unchanged and now matters more: a window whose session scan has not loaded
yet reports nothing active, and acting on that would have deleted every topic in the group.

**`sessionSitter.telegram.idleTopicCloseHours` is removed.** It closed the topic of a session that
was *still active*, which under the new rule just puts a locked thread back in the list. With delete
as the only cleanup there is one rule and nothing to tune: a session in the worklist has an open
topic, and the moment it leaves, the topic goes.

`lastActivityAt` goes from the topic record with it — the idle timer was its only reader, and a field
still written on every turn for nobody to read is worse than an absent one. Old records on disk parse
fine; the extra key is ignored.

### 0.8.3 — Give the panel a clock, and a spinner that survives a repaint

**A bound is not a bound if nothing checks it.** Every age rule the panel applies is measured against
`Date.now()` at the moment `_partitionSessions` runs: the 2h `working` fallback and the probeless
recency window in `isActiveSession`, the 24h finished→dormant split in `resolveDisplayStatus`, and the
pruning of a dead window's session ids by `readLiveWindows`. But that only runs when the webview
repaints, and every repaint trigger was a *change* signal. The one that matters is gated —
`onDidChangeSessions` fires only when `sessionsFingerprint` moves, and a fingerprint stops moving for
good once a session's raw status settles on a transcript nobody will write to again.

So the panel could not see time pass. A row that should have aged out hours ago kept whatever verdict
the panel last reached, until something unrelated happened in the fleet and the whole list corrected
itself at once. That is how it was found: a day-old session sat at the top of the worklist until a new
session was started in another workspace, at which point the list silently fixed itself. The 60-second
`_registryTimer` was no help — it publishes this window's registry entry and never repaints anything.
`PANEL_REPAINT_MS` now ticks every 15 seconds while the view is visible, skipping hidden panels
because each tick costs two inspector round-trips into other extension hosts. Not a regression: the
same gap is in 0.8.0.

**The `working` spinner was being restarted faster than it could turn.** `renderTabs()` clears the
strip and rebuilds every row on every push, and a brand-new element starts its CSS animation at 0°.
Pushes follow the fingerprint, which for a streaming session means every 250ms watcher debounce —
Claude writes its transcript far faster than that, as the comment on `STREAMING_WINDOW_MS` already
says. So the one state that animates was also the one rebuilt several times a second, and the ring
snapped back to 0 before it had turned a quarter. It read as a ring twitching in place.

The marker's phase is now anchored to the wall clock with a negative `animation-delay`, so each new
element picks up where the one it replaced left off. `SPIN_PERIOD_MS` in `main.js` and the duration in
`styles.css` have to agree for that to work, and a test pins them together — a mismatch is invisible
in review and shows up only as a marker that jumps. Nothing changes under `prefers-reduced-motion`:
there is no animation left to offset.

The underlying waste — tearing down the whole strip several times a second, which also drops hover
state and the row preview — is untouched. Reconciling rows by session id is the fix, and it is its own
change.

### 0.8.2 — Stop a dead session sitting at the top of the worklist

A session killed mid-tool-call was pinned as `approval` **forever**. The two blocked states are the
only ones the worklist never ages out — on purpose, because a session waiting on you is stuck rather
than stale — so it sat at the top of the list for weeks, on the strength of a transcript that would
never be written again, with no process left to answer it and no way to clear it. Found in a real
registry as a 47-hour-old `approval` that no window held.

An unanswered tool call now reads `dormant` once it has been silent for a day
(`ABANDONED_TOOL_CALL_MS`). Fixed in `sessionStatus.ts` rather than in the worklist filter, so the
panel and Telegram both get it from one rule. Nothing is lost by the bound: a session whose window is
still open stays in the worklist through the live probe, which never consults the status, and Bob's
live pending approvals still upgrade a row at any age. It only bites when *no* live signal agrees
with the file — the case where the file is the thing that is wrong.

**The window registry now writes atomically.** `writeWindowEntry` truncated and wrote in place, so a
reader on its timer could catch a fragment, and a process killed mid-write left one behind for good —
two 0-byte entries had been sitting in a real registry since July. It writes to a temporary name and
renames, like `TopicStore` already did. Cleanup was the other half: an unparsable entry was skipped
but never deleted, because the old code only removed a file *after* parsing it. Unparsable entries are
now cleaned once they are older than the 24h staleness bound — age-gated, so a window mid-recovery is
never made invisible to its peers.

**Two things that could hide the same symptom are now visible in the log**, rather than needing a
guess:

- `PendingWatcher` names every blocked session on each change, and says so when nothing is blocked.
  This map is the only input that can make a row `approval` or `question`, and those never age out —
  one stale entry pins a row indefinitely. It used to log only when the *read failed*, which made
  "why is this old task in my active list?" unanswerable.
- The Claude inspector calls out sessions that have state but no open panel. `open` is
  `sessionPanels ∪ sessionStates`, so each of those counts as held by the window, and therefore
  active at any age. Whether Claude drops a session's state when its panel closes is undocumented and
  was not reproducible, so the union is **unchanged** — this is instrumentation, not a behaviour
  change, and the log now says which ids to suspect.

### 0.8.1 — Telegram shows the active sessions, and only those

The Telegram group used to list every session the machine had ever seen. A fleet accumulates
hundreds, and a list of hundreds answers no question — you cannot find the one that needs you in it.
It now shows exactly what the **Sessions panel** shows: the active worklist.

Not "the same by convention". The rule moved into `src/sessionActivity.ts`, a pure module both
surfaces call, so there is one definition of *active* and nothing to keep in sync. Telegram also
reads the panel's **display** statuses, so an amber row in the sidebar is an amber row on your phone.

A session that leaves the active list has its topic **closed**, right then rather than after a
timeout — closed, never deleted, so the scrollback stays and the topic reopens by itself if the
session comes back.

```
  # General                            ← /sessions /history /new /who /help
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

**Names now read status → workspace → title → agent → machine.** The workspace comes first because
it says which piece of work this is, which is the question a list of twenty rows is actually asked.
The agent and the machine trail, and the machine appears only when it is not this one. The list is
no longer grouped by host — that heading put the machine name above the workspace, which is exactly
backwards. Same order in the topic name, the list row, the topic header and `/who`.

**`/history`** reaches everything the worklist does not, newest first. Tapping a row opens its topic
*and* focuses the session in its IDE — the second step is what returns it to the active list, since
active means a window has it open. So there is no second, Telegram-only notion of active to drift
out of step with the panel.

The status glyphs are unchanged but now pinned by a test against
[`docs/STATUS-INDICATORS.md`](docs/STATUS-INDICATORS.md), which gained a Telegram column. Amber is
your turn wherever you read it.

### Telegram as a remote interface to your sessions

Your sessions now appear as **topics** in a Telegram forum group. Open a topic to read that session's
turns as they happen, and type in it to send a message straight into the agent. Off by default —
`sessionSitter.telegram.remoteControl`.

```
GROUP "Session Sitter"  (Topics enabled)

  # General                            ← the live list
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

Topics were chosen over a menu message or a card-per-session because the thread *is* the selection:
there is no "which session am I talking to?" state to get out of sync, unread badges are per session,
and each session keeps its own scrollback. Supervision cards for a session now land in that session's
topic instead of one undifferentiated feed.

A topic appears automatically for every active session, and on demand for the quiet ones (see the
entry above for which sessions count as active). Its name leads with the status, so the topic list
doubles as a status board in the same amber / green / grey language the panel uses. A topic is
**closed** — never deleted — after `sessionSitter.telegram.idleTopicCloseHours` of quiet, reopening by
itself if the session revives.

`/new` starts a session, offering the workspaces that currently have a window open. That list comes
from the live window registry rather than a configured allowlist, so it can never offer a target
nothing could run in.

**What can be written to.** Reading works for all four agents. Writing does not, and the limit is in
the agent rather than here:

| Agent | Read | Write |
|---|:---:|---|
| Bob | ✅ | ✅ any task, live or historical |
| Claude | ✅ | ⚠️ sessions open in their own window |
| Codex | ✅ | ❌ no message API exists |
| VS Code Chat | ✅ | ❌ no message API exists |

A read-only topic says so in its header rather than accepting your message and dropping it.

**Claude targeting, and one deliberate refusal.** Injecting a message means writing to a session's CLI
transport, and the sessionId↔channel link is not exposed by every Claude build. It is now searched for
at send time — the channel map key, the channel's own properties, `query.initConfig` — and falls back
to the sole open channel where there is nothing to confuse it with. When several are open and none
matches, **nothing is sent** and the topic says why. Delivering a prompt to the wrong agent is worse
than not delivering it, because the wrong agent acts on it.

**One bot per machine.** A bot token has a single update stream and reading it is destructive, so two
machines sharing one steal each other's messages. Give each machine its own bot and add them all to the
same group; the fleet view is the union of their topics. This removes any need for cross-machine
plumbing — coordination is intra-machine only. Keep the token in the environment or a `.env` file
rather than VS Code settings, because Settings Sync would copy one machine's token to all of them.

**Fixed along the way: windows no longer fight over Telegram.** Every window with `autoSupervise` on
and a state dir set was polling `getUpdates` with the same token and one shared offset file, so replies
were already being split between windows at random. It half-worked because the state dir is shared, but
for Claude the decision was then applied to the *wrong* session. Reading is now held by one window per
machine under a renewable lease, and an inbound reply is routed to the window that owns the session it
belongs to.

**Ownership is claimed by what a window holds, not by path.** A window claims a session it actually has
open, from the ids the window registry already publishes; failing that, the window whose workspace is
the longest containing folder; failing that, nobody and the session is read-only. The path tier gets
this repository's own worktree convention right — a session in `<repo>/.claude/worktrees/feat` belongs
to the worktree's window if one is open — and a separator check stops `/work/app` claiming
`/work/app-legacy`.

**New settings**

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.telegram.remoteControl` | `false` | The master switch. |
| `sessionSitter.telegram.allowedUserIds` | `[]` | Telegram user ids permitted to drive it. **Empty authorises nobody** — a group is not a private chat, and rejected ids are logged so you can copy them in. |
| `sessionSitter.telegram.idleTopicCloseHours` | `24` | How long a session may be quiet before its topic is closed. |

The bot token and chat id are reused from the existing `sessionSitter.supervisor.telegram*` settings,
so supervision cards and the conversation with a session share one group.

Setup, the failure table, and the exact write limits: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

### The plugin evaluates every command in a compound line, not just the first

Claude Code matches permission patterns on a command **prefix**, so `Bash(git:*)` does not match
`git add . && git commit -m x` ([#25441]), and per the community meta-issue [#30519] the same hole
applies to **deny** rules — a written deny could be walked past by appending `&& <the denied thing>`.
The plugin's `PermissionRequest` hook now splits the command line into the commands a shell would
actually run — across `&&`, `||`, `;`, `|`, `|&`, `&`, newlines, `$(…)`, backticks and `<(…)`,
honouring quoting — runs the decision ladder over every one of them, and combines
**deny > ambiguous > allow**. The deny names the offending sub-command and its position, which prefix
matching structurally cannot.

The sharpest thing this fixes is in the *allow* direction: a written green clause used to be matched
against the whole line as one string, so `Match: npm test` licensed anything that merely contained
those words — `npm test && curl … | sh` included.

It is fail-closed. A line the splitter will not vouch for — unbalanced quote, unterminated
substitution, arithmetic `$(( ))`, substitution nested more than four deep — is *ambiguous*, never
safe. That has a real cost, stated in `docs/PLUGIN.md`: `npm test -- --shard=$((1 + 1))` is denied
even with a green clause covering `npm test`. The splitter is `src/policy/shell.ts`, hand-written,
because this repository has no runtime dependencies.

### "Always allow" writes the rule you meant, not the command you typed

Claude Code's own dialog saves the literal command string, so the rule never matches again and
`settings.local.json` fills with dead entries ([#6850], [#11380]) — or it offers a wildcard far wider
than the subcommand you approved ([#29187]). With `SESSION_SITTER_PERSIST_RULES=on`, a call allowed by
a written green clause now comes back with a `decision.updatedPermissions` **derived from that
clause**: `Match: npm test` becomes `Bash(npm test:*)`, and the audit record cites the clause. It
emits nothing — letting the prompt come back — for a deny, a correction, a deterministic-tier allow,
a compound, a regex matcher, or a substring that did not start the command. `session` is the default
destination; `SESSION_SITTER_RULE_DESTINATION` moves it.

### A `ConfigChange` hook guards your permission configuration

An agent that can edit `.claude/settings.json` can add itself an allow rule, delete the deny rule
stopping it, or set `defaultMode` to `bypassPermissions`. The new hook blocks a change that widens
what the agent may do and allows a narrowing. Because the platform documents that "a blocked change
surfaces no message to you or to Claude", the audit record is the only place either decision is
visible — so every one is recorded with `built-in §config-guard`. `policy_settings` is recorded and
allowed through, because the docs are explicit that it cannot be blocked.

All three are verified against the real `claude` v2.1.252 binary, with the captured hook JSON in
`docs/superpowers/specs/2026-09-02-permissions.md` — including what is *not* verified.

[#6850]: https://github.com/anthropics/claude-code/issues/6850
[#11380]: https://github.com/anthropics/claude-code/issues/11380
[#25441]: https://github.com/anthropics/claude-code/issues/25441
[#29187]: https://github.com/anthropics/claude-code/issues/29187
[#30519]: https://github.com/anthropics/claude-code/issues/30519

## 0.8.0

### The session list can hold still, and it sorts six ways

The list was always sorted by recency, so every status change reshuffled it. Reading a list of a
dozen sessions across five checkouts meant the row you were aiming at moved under the cursor — and
recency tells you nothing about *which* session a row is, which is the question you actually have
when several of them look alike.

A **⇅** button in the toolbar now picks the order, and the choice is written to
`sessionSitter.sessionSort`, so it survives a reload and applies in every window:

| Order | Rows hold still |
|---|---|
| `recent` — newest activity first (the default, unchanged) | no |
| `hostWorkspace` — machine, then workspace, then title | yes |
| `workspace` — workspace, then title, across machines | yes |
| `source` — agent (Claude, Bob, Codex, Chat), then workspace | yes |
| `title` — A to Z | yes |
| `status` — waiting on you, then running, then idle | no |

"Holds still" is a property of the comparators, not a hope: every one of them is total, falling
through to the session id, because a comparator that ties leaves those rows in whatever sequence
the scan produced — and that sequence changes between passes. The modes live in one place
(`sessionSort.ts`) and the panel builds its menu from the list the extension host sends, so the
panel cannot offer an order the sorter does not implement.

The cap on the list (20 rows, 50 in History) is still applied by **recency**, before the display
sort. Sorting by title and then taking the first 20 would drop the sessions you touched most
recently, which is the opposite of what a worklist is for.

### Each workspace can have its own colour

Every workspace pill was the theme's badge colour — one colour for every project, which is no help
at all when the panel lists sessions from five checkouts. `sessionSitter.workspaceColors` maps a
workspace to a colour:

```jsonc
"sessionSitter.workspaceColors": {
  "session-sitter": "green",
  "/home/you/work/payments": "#c0392b",
  "scratch-*": "slate",
  "*": "auto"
}
```

A key is a workspace name, a full path, or a glob over either, and the first matching key wins — the
same rule `sessionSitter.autoRespond` already uses. A value is a hex colour, one of seventeen built-in
names, or `auto`, which hashes the workspace into the palette: the same project gets the same colour
in every window and on every machine, with nothing to configure. The label colour is picked for
contrast automatically, so a light fill still reads.

The default is unchanged: a workspace with no rule keeps the theme colour. A value that is not a
colour is ignored rather than fatal, so a typo shows up as "this project is not coloured" instead of
a broken panel.

Both settings are read by the extension host on every push and take effect as soon as you edit them
— including for peer sessions, so the same project looks the same wherever it is running.

## 0.7.3

### The project has a logo

There was no picture anywhere. The README opened with a bare `<h1>`, the marketplace tile fell back
to the grey default placeholder, and the GitHub repo card was text on grey. For a tool whose whole
pitch is a panel you look at, that is a bad first impression — and the marketplace ranks and renders
an extension with no icon worse than one with any icon at all.

The mark is three agents tucked in a cradle over the red / amber / green supervision light: it is
sitting with your sessions, and it grades what they pause on. `package.json` now declares
`icon` and a `galleryBanner` in the badge's navy, so the marketplace tile and its header are
branded. The README header is a wordmark that swaps with the reader's light or dark theme.

Every asset is original artwork and lives in [docs/branding/](docs/branding/) with the palette and a
regeneration script. It borrows no vendor's mark, and the palette avoids Claude's orange on purpose
— the extension supervises Claude Code, IBM Bob and Codex alike, so looking like any one of them
would be both a licensing problem and a lie about what this is.

The marketplace icon is a copy at `resources/logo.png` rather than a reference into `docs/`, because
`.vscodeignore` keeps `docs/` out of the `.vsix`. `resources/icon.svg` is untouched: the activity-bar
glyph has to stay monochrome `currentColor` so VS Code can tint it to the user's theme.

## 0.7.2

### Activity rows and Telegram cards now say which session, and which machine

A decision card named its session by id and nothing else. Every id looks the same, so the panel
listed a column of interventions with no way to tell which session each one landed in — and with
several machines reporting into one Telegram chat, a card could not even be attributed to a host.
Approving from your phone meant guessing.

Each record now carries the session's name (its panel title, else its project name) and the short
name of the machine it ran on. The activity row shows `🗂 <name>` with `🖥 <host>` and keeps the id in
its tooltip; the Telegram `session:` line reads `session: <name> @ <host> (<id>)`. Both tiers set
them: the supervisor takes the name from the transcript it just classified, and a deterministic
`autoRespond` decision takes it from the session list, so a rule card is as attributable as an AI
one. A peer's session is credited to the peer's machine, not to this one.

One formatter serves the card and the feed, and it falls back to the id rather than to an empty
label — so a record written before these fields existed still reads exactly as it used to.

## 0.7.1

### Peer sessions landed in History instead of the session list

0.7.0 pulled a peer's sessions correctly and then hid them. A session reaches the active list only
when some **live window** reports it open, and that set was built from `readLiveWindows`, which
reads this machine's registry directory and tests liveness with `process.kill` — neither of which
can say anything about a process on another host. So a peer session was never "reported open" and
fell through to the status fallback, which an idle session waiting at a prompt fails. The session
was pulled, tagged, and filed under History, which looks exactly like a session that was never
found at all.

The peer's own window entries now count as reporters alongside the local ones. They are the right
authority: the probe resolves liveness with `kill -0` on the machine that owns the pid, so a peer
window entry is as trustworthy about its machine as a local entry is about this one. An unreachable
peer publishes no windows, so it vouches for nothing.

### Your own machine is no longer probed, or reported unreachable

An IDE records this host's own LAN address as an `ssh-remote` target as readily as any other, and a
machine has no reason to hold an authorized key for itself — so the extension probed itself, failed
on publickey, and named the user's own machine as unreachable in the panel, every pass, forever.

Self-detection could not be left to the probe's `machineId` reply, because that answer only arrives
after the SSH that is failing. Discovery now recognises this host up front, by its interface
addresses and its own name, and drops it before any connection is attempted. Host names are
compared on whole labels, never as substrings: hiding a real peer is worse than probing one extra
host.

## 0.7.0

### Sessions from your other machines, with no configuration

Two IDE windows attached to two different machines showed two different session lists, and there
was no way to see one from the other. Nothing was broken: every session source is rooted at
`os.homedir()`, and this extension runs in the *remote* extension host on purpose so it can reach
the remote filesystem. One extension host per machine means one `$HOME` per machine, so "across
windows" had always quietly meant "across windows on this machine".

The panel now also shows sessions from peer machines, tagged with the machine they live on, and
clicking one focuses the window on **its own** machine.

There is nothing to configure. The IDE already records every remote window you have opened as an
`ssh-remote+user@host` entry in its own state store, so peers are read from there — a local file
read, no SSH traffic, and it yields the exact address the IDE itself connects with. Peers are then
probed over SSH with one connection each, reused via `ControlMaster` and refreshed on a slower timer
than the local scan, so a peer on a slow link can never stall the local session list.

Reachability is one-way in practice: this machine may reach a server that cannot reach back through
NAT. So each window shows what it can reach and names what it cannot, rather than letting an
unreachable machine look like a machine with nothing running. SSH runs with `BatchMode=yes`
throughout — a host that would prompt for a password is reported unreachable instead of wedging a
background timer on a prompt nobody can see — and a failing peer backs off exponentially.

Supervision stays local to the machine that owns the session, which is also the machine that can
act on it.

Set `sessionSitter.remotePeers` to `off` to disable all of it: no discovery, no polling, and no SSH
connection of any kind.

## 0.6.3

### Deterministic decisions are reported without any configuration

Ask a Bob session to run `date`, watch Session Sitter click **Allow once** for you, then look at
the **Supervision activity** panel and at Telegram: nothing. The decision happened and left no
trace anywhere.

The cause was one setting standing in for two unrelated things. `sessionSitter.supervisorStateDir`
gated the AI supervisor — correctly, since it shells out to a classifier CLI and must stay opt-in —
but it also gated every *reporting* destination, because records live under that directory. A
`sessionSitter.autoRespond` rule needs no supervisor and no settings at all, so on a default
install the rules fired and the reporter was never built: `onRuleDecision` was `undefined`,
`AutoResponder.report()` returned immediately, and the panel had no feed to read. The only hint was
one line in an Output channel nobody had open — and the on-disk log that would have said so also
lived under the state dir that did not exist.

The two are now separate. The state dir always resolves, falling back to the extension's own global
storage, so a rule decision is always recorded and always shows up in the activity feed. What still
gates the supervisor (and the outbox that serves it) is whether you *set* the setting, not whether a
path happens to resolve — defaulting a path must never start a classifier nobody asked for. The
activation log now names the state dir in use, which also makes the multi-window case diagnosable:
on a remote setup the panel and the deciding window must read the same settings.

Telegram is the one part that genuinely needs configuring. When rule notifications are on but no
channel is set up, the log now says so explicitly instead of leaving the silence unexplained.

## 0.6.2

### A session you interrupted no longer sits in the active list forever

A Claude session last touched a month ago stayed in **Sessions** instead of falling back to
History. Two things combined to keep it there.

**A `type: "user"` record is not always the user typing.** Status is inferred from the tail of
the transcript, and any user-type record was read as "you sent a message, Claude has not replied
yet" — status `waiting`. But Claude Code writes several other things as user-type records: every
tool result (carrying `toolUseResult`), injected context such as skill loads and scheduled prompts
(`isMeta`), and the `[Request interrupted by user]` marker. The reported session ended on that
interrupt marker, written *after* the `last-prompt` terminal record, so the backward scan returned
`waiting` before it ever reached the marker that says "this session is done". A transcript never
written to again reports `waiting` forever.

The scan now skips those three kinds of record and keeps looking backward, so it reaches the real
signal behind them. A genuine prompt still reports `waiting`, and a tool result still reports
`active` while the tool is in flight.

**The non-idle fallback had no age bound.** A Claude or Bob session counts as active when its
extension host reports it open, *or* when its status is not idle. That second clause exists to
survive a momentary probe failure (a WSL2 / inspector hiccup), but it applied at any age — so one
mis-read status pinned a session in the worklist indefinitely. The fallback is now bounded to two
hours, matching the recency window already used for Codex and VS Code Chat. A live report from a
probe stays authoritative at any age.

## 0.6.1

### Switching to a Claude session now focuses it where it already is

Clicking a Claude session that was open in the **side bar** opened a *second* view of it as a new
editor tab, instead of focusing the one already on screen.

`claude-vscode.primaryEditor.open` reads like "focus this session", but it is not. It calls Claude's
`createPanel`, which reveals an existing panel only when its `sessionPanels` map holds the session
id, and otherwise **creates a new panel**. A session living in the side bar is never in
`sessionPanels`, so switching to it always built a duplicate.

Switching now asks Claude where the session actually is before acting:

- **Open as an editor panel** → reveal that panel, in whatever editor group it sits in.
- **Held by this window with no panel, and `claudeCode.preferredLocation` is `sidebar`** → focus the
  side bar, which is where it is showing.
- **Closed or older session** → open it by id, reopening the conversation. Unchanged.

The same rule now applies to adding a session from **History**, which had the identical problem.

Known limit: Claude exposes no per-session side bar API and does not track which session its side bar
is showing, so in the second case Session Sitter can focus the side bar but not force it to a
specific session. This matches what Claude's own "Claude Code: Open" command does.

Internally, the open-sessions probe now reports Claude's `sessionPanels` and `sessionStates` maps
separately instead of merging them, because the difference between the two is what says *where* a
session lives. A merged set could not tell a live side bar session from a closed one.

## 0.6.0

**Every intervention is visible, and everything is configured from settings.**

### Deterministic rule decisions are now recorded and reported

Until now only the supervisor's decisions reached you. A `sessionSitter.autoRespond` rule that
auto-approved a tool prompt, auto-rejected one, or sent a canned reply changed what your agent did
and left no trace outside the log.

Every applied rule now writes a supervision record under `<stateDir>/records/` — the same file
shape the supervisor writes, with `decided_by: "rule"` and a `rule` trace naming the pattern that
fired — and posts a **one-way update** to your messaging channel.

- The **Supervision activity** panel tags each card **⚙ rule** or **🧠 AI**, and shows the rule
  pattern that fired.
- The light follows the outcome: approve → 🟢, reject → 🔴, canned text reply → 🟡.
- A rule decision is never an interactive card. The decision is already made; there is nothing to
  ask.
- This needs only `sessionSitter.supervisorStateDir`. Rule decisions are recorded and reported even
  with `sessionSitter.autoSupervise: false`, because no classifier is involved.
- New `sessionSitter.supervisor.notifyRuleDecisions` (default `true`) keeps them out of Telegram
  while still recording them.

A decision is reported only once it actually reached the agent: a failed resolve or a failed send
reports nothing. Reporting can never delay or break applying a decision — a broken record write or
a dead channel is logged and dropped.

### Supervisor configuration moved into settings.json

The supervisor used to read its engine, credentials, channel and timeouts from the environment or a
`.env` file. All of it is now a `sessionSitter.supervisor.*` setting, editable in the Settings UI:

| Was | Now |
|---|---|
| `SUPERVISOR_ENGINE` | `sessionSitter.supervisor.engine` |
| `BOB_CLI_PATH` | `sessionSitter.supervisor.bobCliPath` |
| `CLAUDE_CLI_PATH` | `sessionSitter.supervisor.claudeCliPath` |
| `BOB_API_KEY` / `BOBSHELL_API_KEY` | `sessionSitter.supervisor.bobApiKey` |
| `ANTHROPIC_BASE_URL` | `sessionSitter.supervisor.anthropicBaseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `sessionSitter.supervisor.anthropicAuthToken` |
| `CLAUDE_TIMEOUT_SECONDS` | `sessionSitter.supervisor.classifierTimeoutSeconds` |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `sessionSitter.supervisor.orangeResponseTimeoutMinutes` |
| `MESSAGING_CHANNEL` | `sessionSitter.supervisor.messagingChannel` |
| `TELEGRAM_BOT_TOKEN` | `sessionSitter.supervisor.telegramBotToken` |
| `TELEGRAM_CHAT_ID` | `sessionSitter.supervisor.telegramChatId` |
| `RED_NOTIFY` | `sessionSitter.supervisor.redNotify` |
| `KNOWLEDGE_REPO` | `sessionSitter.supervisor.knowledgeRepo` |
| `KNOWLEDGE_REF` | `sessionSitter.supervisor.knowledgeRef` |

**Not breaking.** The environment and `.env` are still read as a fallback for any setting you have
not set, so an existing install keeps working untouched. Precedence is: an explicitly-set setting >
process environment > `.env` files > built-in default. VS Code stores settings in plain text, so
leaving a credential setting empty and keeping the environment variable is a supported choice.

The standalone supervisor CLI (`node out/supervisor/cli.js`) has no settings to read and is
unchanged — environment plus flags.

### Also

- New command **Session Sitter: Open Settings**, and the panel's **☰** menu now offers
  **All settings…**, **Auto-respond rules…** and **Supervisor settings…** separately.
- One messaging channel per window, shared by the supervisor and the rule reporter — two Telegram
  consumers on one bot would fight over `getUpdates`.

## 0.5.0

**The project is now Session Sitter.** Same extension, one name, and one settings namespace.

### Breaking: every setting moved

Two namespaces collapsed into `sessionSitter.*`. The old names are **not** read, so an existing
configuration needs renaming — a stale key is silently ignored, which looks like the feature simply
not working.

| Before 0.5.0 | 0.5.0 |
|---|---|
| `claudeSessionSwitcher.autoRespond` | `sessionSitter.autoRespond` |
| `claudeSessionSwitcher.probelessActiveWindowMinutes` | `sessionSitter.probelessActiveWindowMinutes` |
| `reckon.supervisorStateDir` | `sessionSitter.supervisorStateDir` |
| `reckon.autoSupervise` | `sessionSitter.autoSupervise` |
| `reckon.supervisorRepoPath` | `sessionSitter.supervisorRepoPath` |
| `reckon.dataRepoPath` | `sessionSitter.dataRepoPath` |
| `reckon.knowledge.user` · `.project` · `.team` | `sessionSitter.knowledge.user` · `.project` · `.team` |
| `reckon.knowledge.registryPath` | `sessionSitter.knowledge.registryPath` |
| `reckon.uploadScriptPath` | **removed** — set `sessionSitter.dataRepoPath` instead |
| `reckon.pythonPath` | **removed** — it was already unused |

Command ids moved the same way: `claudeSessionSwitcher.refresh` → `sessionSitter.refresh`, and so
on for all 17.

### Breaking: two paths on disk

| Before 0.5.0 | 0.5.0 |
|---|---|
| `~/.claude/session-switcher/` | `~/.claude/session-sitter/` |
| `<stateDir>/session-switcher.log` | `<stateDir>/session-sitter.log` |

The first is cross-window focus state and is rebuilt within a minute, so there is nothing to move.

**Your supervision state carries over untouched.** Records, transcripts, the outbox and the
messaging offset all keep their format — point `sessionSitter.supervisorStateDir` at the same
directory and pending decisions resume with their deadlines intact.

### Also in this release

- The extension id is `eranra.session-sitter`; the panel is titled **Session Sitter**; the output
  channel and the command category match.
- **`ci/check-naming.sh`** fails the build on any leftover of a previous name, in code or in prose.
  No allowlist except this file.
- **`ci/check-settings.mjs`** asserts that every setting the code reads is declared in
  `package.json`, and vice versa. It was written after the rename produced exactly that drift —
  the code read one namespace while the declarations used another, and nothing failed: every
  `config.get()` just returned its fallback. A compiler cannot catch that; comparing the two sides
  can.

## 0.1.0

- Consolidated a private supervision runtime into this extension as **TypeScript only** — roughly
  2,600 lines of Python (a traffic-light supervisor, a session-corpus uploader, a secret masker and
  a knowledge loader) ported to `src/supervisor/` and `src/corpus/`, with the behavior contracts
  intact.
- Added traffic-light supervision of the actions an agent pauses on, the Bob and Claude
  extension-host bridges, the supervision activity feed, and approval rules alongside the existing
  text rules.
- Added CI (compile, lint, 602 tests on Node 20 and 22, packaging, docs links, spellcheck, guards),
  a release pipeline, and a Makefile.

## 0.0.x

Session panel for Claude Code and IBM Bob IDE: live status, one-click switching, cross-window
focus, hover preview, history. Later added Codex CLI and VS Code Chat as sources, full-transcript
export, and the Copy transcript submenu.
