# Status indicators: what the marker on each row means

Every session in the panel carries a small marker on its left. This document says what each one
means, exactly how it is decided, and where the answer is guessed rather than known — separately
for Claude Code and for IBM Bob, because the two are read in completely different ways.

It is both the user reference and the design record. If the two ever disagree with the code, the
code in [`src/sessionStatus.ts`](../src/sessionStatus.ts) is the source of truth and this file is
the bug.

---

## The seven states

| Marker | In Telegram | State | Means | Your move |
|:---:|:---:|---|---|---|
| spinning green ring | 🔄 | `working` | Running a tool, or writing a reply | Nothing — it is busy |
| solid amber arrow | 🟠 | `approval` | Paused on a permission prompt | Approve or reject it |
| amber question mark | ❓ | `question` | Asked you something | Answer it |
| green dot in a ring | 🟢 | `finished` | Done, and you have not opened it since | Read the result |
| red pause bars | 🔴 | `stalled` | Stuck on a rate limit, an API outage or a compaction | Nothing — it is not your turn |
| small grey dot | ⚫ | `seen` | Done, and you have read it | Nothing |
| hollow grey circle | ⚪ | `dormant` | Nothing happening, or no signal to tell | Nothing |

The Telegram column is the same state in the one medium that has no shapes, only characters — see
[`TELEGRAM.md`](TELEGRAM.md). The colour language survives the move, which is what matters: amber is
your turn wherever you read it. The glyph set is pinned by a test in `src/test/telegram/render.test.ts`,
so it cannot drift away from this table by accident.

They answer one question — **whose turn is it, and why** — and they are ordered above the way
urgency runs. Pick **Needs you first** from the sort menu (**⇅**) and the list is sorted in exactly
that order: `approval`, `question`, `finished`, `working`, `stalled`, `seen`, `dormant`.

### Why shape and not just colour

Each state has its own silhouette, not merely its own hue. A 10px dot has no room for detail, so
the outline is what you actually recognise at a glance, and it keeps working for anyone who cannot
separate the colours and in a high-contrast theme where the palette is overridden.

**Only `working` moves.** Anything that animates reads as "busy, leave it alone" — which is the
worst possible thing to say about a session sitting blocked, waiting for you. `stalled` is static
for the same reason read the other way: the session has *stopped* moving, and a spinning ring
would claim the opposite.

The `working` ring turns even if your system asks for reduced motion. That is a deliberate
exception, and the only one: the turning *is* the signal. A stopped ring says nothing the other five
shapes do not already say better, so stopping it does not simplify the marker — it deletes the
difference between "busy right now" and "sitting there". On Windows, one switch controls this
(**Settings → Accessibility → Visual effects → Animation effects**), and with it off every page the
editor renders is told to reduce motion, this panel included. Honouring it here cost the panel its
only liveness cue on a whole class of machines, with nothing on screen to say why.

### Why `seen` and `dormant` are different shapes

They mean genuinely different things: "finished, and you read it" versus "nothing is happening, or
we have no way to tell". Rendering the second as a dimmer copy of the first would rebuild the exact
ambiguity this state set exists to remove, so `dormant` is an outline and `seen` is filled.

---

## Two signals, and which one wins

A session's state comes from two places, and they are not equal.

**The floor: what the session's own storage says.** A transcript file or a database row. Always
available, for every session, on this machine or a peer. But limited — see the per-agent rules
below.

**The upgrade: a live read from the agent's extension host.** This is certain, because the agent
itself is being asked. But it only covers sessions in windows on *this* machine, and only for Bob
(see the gap below).

**The other upgrade: what our own hooks saw.** For Claude, the plugin's hooks run inside the session
and record the blocked state keyed by session id — see [below](#the-gap-for-claude-and-how-the-plugins-own-hooks-close-it).
Available only where the plugin is installed, and outranked by a live host read when both speak.

The rule between them is asymmetric, and it matters:

> A live signal may **upgrade** a state. Its absence never **downgrades** one.

Because "no pending approval was reported" almost never means "there is no pending approval" — it
routinely means the session is open in a different window, or the inspector hiccupped. Treating
that silence as proof would turn every cross-window approval prompt grey, which is the failure
this design exists to fix.

---

## Claude Code

Claude's transcript (`~/.claude/projects/**/*.jsonl`) is append-only, so the only liveness signal
it carries is **how long ago it was last written**. The last 32 KB is read, records are walked
backward, and the newest record that says anything about status decides. Records that say nothing —
`ai-title`, `file-history-snapshot`, injected context (`isMeta`) such as skill loads — are skipped
rather than treated as an answer.

| Last meaningful record | Quiet for | State |
|---|---|---|
| tool result | < 45s | `working` |
| tool result | ≥ 45s | `dormant` (turn abandoned there) |
| unfinished tool call | < 45s | `working` |
| unfinished tool call | ≥ 45s | **`approval`** |
| unfinished tool call | ≥ 24h | `dormant` (nothing is left to answer it) |
| unfinished call to `AskUserQuestion` | < 24h | **`question`** |
| unfinished call to `AskUserQuestion` | ≥ 24h | `dormant` |
| user prompt | < 2min | `working` (about to start) |
| user prompt | ≥ 2min | `dormant` (nobody ever answered) |
| assistant text | < 30s | `working` (still streaming) |
| assistant text | ≥ 30s | `finished` |
| API error (rate limit, outage) | < 5min | `working` (retry may be in flight) |
| API error (rate limit, outage) | ≥ 5min | **`stalled`** (never `approval` — nobody is being asked) |
| compaction | < 5min | `working` (it resumes on its own) |
| compaction | ≥ 5min | `stalled` |
| `pr-link` / `last-prompt` | any | `finished` (session closed out) |
| interrupt marker you typed | any | `finished` |
| nothing conclusive | < 30s / ≥ 30s | `working` / `dormant` |

### The trick that makes `approval` work without a live read

A tool that is genuinely executing keeps the transcript moving. A tool sitting on a permission
prompt writes **nothing at all**. That difference in silence is the only way to tell "running" from
"blocked on you" from the file alone — which is why the unfinished-tool-call row above splits on 45
seconds.

This is the bug this design was built to fix. Before it, an unanswered tool call was green
"regardless of recency", so a session waiting for your approval spun busily forever and read as
*leave me alone*.

A question skips the 45-second timer: an unanswered `AskUserQuestion` is a question after two
seconds and after three hours, because nothing else could have happened in the meantime.

### Why both blocked states give up after a day

`approval` and `question` are the two states the worklist filter never ages out — deliberately, since
a session waiting on you is stuck rather than stale. That makes the *upper* bound load-bearing: a
session killed mid-tool-call would otherwise be `approval` forever, sitting at the top of the
worklist for weeks on the strength of a file that will never be written again, with no process left
to answer it and no way for you to clear it. This was real — a 47-hour-old `approval` no window held.

After a day, silence is evidence of abandonment rather than of patience. Nothing is lost by drawing
the line there: a session whose window is genuinely still open stays in the worklist through the live
probe, which never consults the status at all, and Bob's live pending approvals still upgrade the row
regardless of age. The bound only bites when *no* live signal agrees with the file — which is exactly
the case where the file is the thing that is wrong.

### The gap for Claude, and how the plugin's own hooks close it

Claude's live pending approvals **cannot** be attached to a session *through the inspector*. They
carry a comms channel id, not a session id, and the channel-to-session mapping is not available to
us — the same gap that stops auto-approve rules honouring `sessionPattern` for Claude. Attaching one
anyway would put one session's prompt on another row, which is worse than inferring.

But the inspector is not the only route. When the [plugin](PLUGIN.md) is installed, its hooks run
*inside* the session, and they are keyed by `session_id` — which is exactly the join key the
inspector lacks. Two of them observe the blocked state directly:

| Hook | Writes | Says |
|---|---|---|
| `PermissionRequest` | `decisions.jsonl` | An exempt record (`decision: none`, `actor: human`) for `AskUserQuestion` and `ExitPlanMode` — the layer was asked and deliberately left the question to you. Lands when the tool is called. |
| `Notification` | `activity.jsonl` | `permission_prompt`, ~6s after a dialog appears; `idle_prompt`, ~60s after a turn ends with nobody typing. |
| `PostToolUse` | `activity.jsonl` | A tool produced a result — which is what *closes* a prompt. |
| `SessionEnd` | `activity.jsonl` | The session is over. |

[`src/hookActivity.ts`](../src/hookActivity.ts) folds those into a per-session state and
[`HookActivityWatcher`](../src/HookActivityWatcher.ts) polls them every 4 seconds, feeding the same
`pending` slot on `resolveDisplayStatus` that Bob's `PendingWatcher` uses.

**It is a bracket, not a timer.** A prompt is open until a record closes it, which is what lets a
stale `approval` be *retracted* rather than waiting out the 24-hour bound. A named prompt is closed
only by its own tool — Claude runs several tools per turn, so an auto-approved `Read` finishing while
an `ExitPlanMode` prompt is on screen proves nothing about that prompt. An unnamed one (a
`permission_prompt` notification carries no tool name) is closed by the next completed call
whatever it was, because over-holding is the worse failure: an `approval` nothing can clear has no
timer to fall out of.

So for Claude there are now two paths, and the asymmetry rule still governs which wins:

- **With the plugin installed** — `approval` and `question` arrive in ~6 seconds, a question arrives
  the moment the tool is called, and an ended session drops its blocked state immediately.
- **Without it** — the transcript heuristic above, with its 45-second latency. Unchanged.

Silence from the trail means "no hook told us anything", never "nothing is blocked" — hooks only fire
where the plugin runs. The single exception is `SessionEnd`, which is a positive observation of an
ending rather than an absence of evidence, and is therefore the one signal here allowed to *lower* a
status.

### Why a rate limit is `stalled` and not `approval`

A tool call and a rate limit look identical from outside: a transcript that stops moving. The 45
second rule read that silence as a permission prompt — so a rate-limited session claimed to be
blocked on you, and because `approval` is never aged out of the worklist it pinned itself to the top
of the list on the strength of a prompt that did not exist and that you could not clear.

Claude writes a synthetic `assistant` record for a failed API call (`isApiErrorMessage: true`, text
beginning `API Error:`), and it is checked **before** the tool-call branch — otherwise the walk skips
it, reaches the call underneath, and reports a call the API never answered as waiting on you.
Compaction is treated the same way: it writes nothing while it runs and then resumes on its own, so
it is `working` briefly and `stalled` if it never returns.

`stalled` is deliberately **not** blocked-on-you. There is nothing to click, so it stays subject to
the worklist's normal age bound instead of being exempt from it.

### Four deliberately bounded timers

Each window is "quiet for longer than this means something different happened", and they are
separate because the cases tolerate very different silences:

- **30s** (`STREAMING_WINDOW_MS`) — token streaming writes far more often than this.
- **45s** (`TOOL_STALL_MS`) — long enough that a slow-but-live tool is not mistaken for a prompt.
- **2min** (`PROMPT_WINDOW_MS`) — the agent may be thinking, queued, or reconnecting. Bounded so a
  transcript ending on a prompt nobody ever answered goes quiet instead of pulsing for weeks.
- **24h** (`ABANDONED_TOOL_CALL_MS`) — past this, an unanswered tool call is a dead session rather
  than a patient one. See above; this is the bound that keeps a zombie out of the worklist.

---

## IBM Bob

Bob keeps its tasks in SQLite, so there is no tail to read — but the column is nearly useless on
its own, for a reason worth stating plainly:

> **Bob's `status` column says `running` when a task is executing, and `active` when it has
> finished.** Its `active` is the opposite of what the word suggests.

| `tasks.status` | State |
|---|---|
| `running` | `working` |
| anything else (`active`, …) | `finished` |

That is all the row can support. `running` reads the same whether Bob is executing a tool or
sitting on a permission prompt — so on the row alone, Bob could never show `approval` at all.

### What the live read adds

[`PendingWatcher`](../src/PendingWatcher.ts) polls Bob's in-memory approval requests every 5
seconds through the extension host. Bob's pendings carry the **owning task id, which is the session
id**, so each one attaches to exactly the right row: a pending question tool becomes `question`,
anything else becomes `approval`, and that upgrade overrides the database.

If the read fails, the previous map is kept rather than cleared — clearing would turn one inspector
hiccup into "nothing is blocked".

---

## Codex and VS Code Chat

Always `dormant`. Neither exposes any liveness signal: there is no extension host to ask, and
nothing in their stores says whether a session is mid-turn. Their tooltip says so, rather than
implying the session finished.

They are still listed. The worklist keeps them while they were updated recently — the window is
`sessionSitter.probelessActiveWindowMinutes`, 120 by default.

---

## `finished` versus `seen`

`finished` means "done, and you have not looked". Opening the row from the panel stamps the time,
and the marker becomes `seen`. If the session changes again afterwards, it goes back to `finished`,
because there is something new you have not read.

Two details:

- The stamps live in the extension's **global** state, so "I have read this" means the same thing in
  every window — the session list is the same list everywhere.
- An unread result stops shouting after **24 hours** (`UNREAD_MAX_AGE_MS`) and becomes `dormant`. A
  day-old result is history, not a task, and History full of rows demanding attention is no better
  than History full of rows demanding nothing.

Read-tracking is optional. Without it every finished session simply stays `finished` — erring
towards "you have not seen this", never towards silently marking everything read.

---

## How the state affects the worklist

The main list is a live worklist; everything else is under **History ▶**. A session's state feeds
that split:

| State | Kept in the worklist? |
|---|---|
| `approval`, `question` | **Always**, at any age |
| `working`, `stalled` | Yes, while updated in the last 2 hours |
| `finished`, `seen`, `dormant` | No — unless a probe reports the session open |

A live report from an extension host outranks all of this and keeps a session in the worklist at any
age.

Blocked states are exempt from the age bound on purpose. **A session waiting for your approval is
stuck, not stale** — filing it under History hides the one row you actually have to act on. The
bound exists to drop abandoned mid-turn transcripts, whose status is read from a file that will
never change again.

---

## Where this lives in the code

| File | Role |
|---|---|
| [`src/hookActivity.ts`](../src/hookActivity.ts) | Folds the plugin's own hook records into a per-session live state. Pure; the bracket rules live here. |
| [`src/HookActivityWatcher.ts`](../src/HookActivityWatcher.ts) | Polls the two trail files every 4s and hands the panel a snapshot. |
| [`src/sessionStatus.ts`](../src/sessionStatus.ts) | Every rule on this page, as pure functions. No `vscode`, no I/O, no clock of its own — time is always an argument, which is what makes every state testable. |
| [`src/SessionManager.ts`](../src/SessionManager.ts) | Reads the transcript tail and the Bob rows, and hands them to the classifier. I/O only. |
| [`src/PendingWatcher.ts`](../src/PendingWatcher.ts) | Polls Bob's live pending approvals into a session-id → blocked-state map. |
| [`src/SessionSitterViewProvider.ts`](../src/SessionSitterViewProvider.ts) | Folds the live signals and your read-stamps into the state actually shown — once, so the worklist filter, the sort and the row always agree. |
| [`src/webview/main.js`](../src/webview/main.js) | Builds the marker and its tooltip. |
| [`src/webview/styles.css`](../src/webview/styles.css) | The six shapes, and the spin. |
| [`src/sessionSort.ts`](../src/sessionSort.ts) | The **Needs you first** order. |

Tests: [`src/test/sessionStatus.test.ts`](../src/test/sessionStatus.test.ts) pins every rule in the
tables above, and is the executable version of this document. Change one, change both.
