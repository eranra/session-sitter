# Telegram remote control

Drive your sessions from Telegram: see what is running, read a session, and type into it from your
phone. Off by default.

Each **active** session becomes a **topic** in a Telegram forum group, so the thread you are typing
in *is* the session you are talking to. There is no "which session am I addressing?" state to get
wrong.

```
GROUP "Session Sitter"  (Topics enabled)

  # General                            ← the active list, /sessions /history /new /who /help
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

Open a topic and you get that session's turns as they happen, its supervision cards, and a text box
that sends straight into the agent.

Every name reads the same way: **status, workspace, title, then the agent and the machine.** The
status icon leads because "what needs me?" is the question the sidebar is being asked. The workspace
comes next because it says which piece of work this is. Which agent it is, and which machine it runs
on, are worth knowing but never worth reading first — and the machine is shown only when it is not
this one.

---

## Setup

Five steps, once per machine.

**1. Create a group and turn on Topics.**
Make a Telegram **group** (not a channel), open *Manage group → Topics*, and enable it. Topics cannot
be enabled in a one-to-one chat, which is why this needs a group even for a single user.

**2. Create a bot, and disable its privacy mode.**
Talk to [@BotFather](https://t.me/BotFather): `/newbot` for the token, then `/setprivacy` → **Disable**.

Privacy mode is on by default and hides ordinary messages from the bot — it would see `/sessions` but
not the text you type in a session topic. With it on, the feature appears to work and silently
ignores everything you say to an agent.

**3. Add the bot to the group as an admin with *Manage Topics*.**
It creates, renames and closes a topic per session, none of which is possible without that right.

**4. Give this machine its token and the group id.**

```bash
# ~/.supervisor.env, or the environment
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-1001234567890
```

The group id is negative. That is normal.

**5. List who may drive it, and turn it on.**

```jsonc
{
  "sessionSitter.telegram.remoteControl": true,
  "sessionSitter.telegram.allowedUserIds": ["123456789"]
}
```

**Without the allowlist nothing is acted on.** To find your id, turn the feature on, send any message
in the group, and read the *Session Sitter* Output panel — the id of each rejected sender is logged
for you to copy in.

---

## Use one bot per machine

A bot token has a **single** message stream, and reading it removes each message from that stream. Two
machines polling the same token do not each get a copy: every message goes to whichever asked first.
Your reply then reaches the wrong machine, or appears to be ignored.

So give each machine its own bot, and add them all to the same group. Each bot handles the sessions on
its own machine, and the group shows the union — the fleet view emerges without any machine talking to
another.

This is also why the token belongs in the environment or a `.env` file rather than in VS Code
settings: **Settings Sync would copy one machine's token to all of them**, recreating exactly this
problem, invisibly. The setting is still read first if you set it, and the log says which source was
used.

A machine with no bot still appears in the list — its sessions are pulled over SSH by the existing
peer discovery — but they are marked read-only, because only that machine can write to them.

---

## What you can do

### In General

| Command | Effect |
|---|---|
| `/sessions` | Redraw the list of active sessions. One pinned message, edited in place. |
| `/history` | The earlier sessions. Tap one to bring it back into the active list. |
| `/new` | Start a session: pick a workspace, then Claude or Bob. It sends the new session a first message and creates its topic, so you can continue from here straight away. |
| `/who` | Which window owns which session, and why. Explains a read-only row. |
| `/help` | The commands, and the current write limits. |
| `/forget` | Sent **inside a topic**: delete that topic. The way to clear a thread the automatic cleanup cannot see — see [Topics the cleanup cannot see](#topics-the-cleanup-cannot-see). |

The list is ordered by workspace and then title, **not** by time. It is edited in place, and a time
ordering would reshuffle every row on every poll. A row moves only when a session appears,
disappears, or changes status.

Once you have asked for it, the list **keeps itself current** — it is redrawn whenever the fleet
changes, so a session that leaves the worklist leaves the list without you tapping Refresh. The
ticking ages are deliberately not treated as a change: Telegram rate-limits edits to a pinned
message, and re-drawing every few seconds to move "2m" to "3m" would spend that budget on nothing.

### The list holds the active sessions, and only those

The group shows the same sessions the **Sessions panel** shows, and nothing else. A machine
accumulates hundreds of past sessions; a list of hundreds answers no question, because you cannot
find the one that needs you in it.

Both surfaces apply one rule, in [`sessionActivity.ts`](../src/sessionActivity.ts), so they cannot
disagree about the same fleet:

- **Claude / Bob** — active when a live window reports the session open. Failing that, active while
  it is blocked on you (at any age — a session waiting for your approval is stuck, not stale), or
  while it was working recently.
- **Codex / VS Code Chat** — no liveness signal exists for these, so recency is the only honest
  proxy: active while updated inside `sessionSitter.probelessActiveWindowMinutes`.

**A session that leaves the active list has its topic deleted**, right then — not after a timeout.
So the group's topic list is the active list, and nothing else.

Deleted, not closed. Closing was the first design and it does not work: Telegram keeps a closed
topic in the group's topic list, locked but fully visible, so every session that ever ran still
piled up in the sidebar. Only deleting removes one. Nothing that matters is lost — the transcript on
disk is the source of truth, and `/history` builds a fresh topic from it whenever you ask.

A topic you open by hand is left alone for ten minutes whichever list its session is in, so tapping
a `/history` row never leads to a thread that vanishes under you.

A topic you close by hand **reopens when there is a new turn to post**. Reopening on "the session is
still active" instead would undo that close on the very next pass, and new turns are the thing you
would actually have missed.

If the bot cannot delete — it needs `can_manage_topics` in the group — the topic is closed instead
and the delete is retried on later passes, so the reason ends up in the extension's Output log rather
than being silently dropped.

### Topics the cleanup cannot see

Every automatic pass works from the record store in
`~/.claude/session-sitter/bus/topics/<threadId>.json`. One file per topic, written when the topic is
created, deleted when the topic is.

**That store is the only handle on a topic.** The Bot API has no call that lists a group's topics:
`getForumTopics` exists, but it is a user-API method and
[says so explicitly](https://core.telegram.org/method/channels.getForumTopics) — "Only users can use
this method". A bot can create, rename, close, reopen and delete a topic it knows the id of, and it
can learn an id from a message somebody sends in it. It cannot ask what is there.

So a topic whose record is missing is not merely unpruned, it is **invisible**. Pruning never
considers it, the active list never counts it, and nothing will ever remove it. It stays in the
group's topic list for as long as the group exists.

Two things used to cause that, and both are now closed:

- **A record that failed to write.** `createTopicFor` created the topic and then saved the record. A
  failure in between left a live thread that nothing owned. The topic is now deleted again if its
  record cannot be written.
- **A record that could not be read.** `TopicStore.all()` skips a file it cannot parse, which is
  right everywhere except pruning — there, skipping it hides a real thread. The filename is the
  thread id, which is all a delete needs, so `damagedThreadIds()` reports those and the pruning pass
  removes the thread and the unreadable file together.

What neither can fix is a topic whose record was **already** gone — deleted by hand, lost with the
`bus/` directory, or created by a build before the store existed. Nothing can find those, so
`/forget` is the way out: send it inside the thread you want gone. The message carries its
`message_thread_id`, which is the one remaining thing that identifies such a thread, so pointing at
it by typing in it is the only mechanism Telegram leaves available.

Note the store is keyed to the **extension host's home directory**. A WSL-remote window and a
Windows-local window on the same physical machine keep separate stores, and so does every other
machine in the fleet. Each prunes what it created; a topic created by a host that never runs again is
one nothing will clean up, so it wants `/forget` too.

### `/history` — bringing a session back

`/history` lists what the active list does not, newest first, one button per session. Tapping one:

1. opens (or creates) its topic, so you can read it immediately, and
2. focuses the session in its IDE on its own machine.

The second step is what actually returns it to the active list, because "active" means a window has
it open. So the panel and the Telegram list agree about it again from the next pass — nothing is
pinned into the list by hand, and there is no second notion of "active" to get out of step.

If no window on the machine owns the session, the topic is still created and says so: you can read
it, but there is nothing to focus and nothing to write to.

### In a session topic

Type anything and it is sent into that session as a user message. The topic answers with `✅` or with
the reason it could not.

### How much of a turn you get

Each turn is mirrored **whole**, split across as many messages as it takes and numbered `(1/3)`,
`(2/3)`, `(3/3)`. This is what `sessionSitter.telegram.fullMessages` controls, and it is on by
default: the alternative is the ~250-character excerpt the Sessions panel draws in its preview
bubbles, which is enough to recognise an answer sitting beside the session it came from and not
enough to act on one when Telegram is all you have — the part you need in order to reply is usually
the end of it.

`sessionSitter.telegram.maxMessageParts` (default 4, ceiling 20) is the budget. Past it the last
message ends with the exact number of characters left out and points at **📄 Full transcript**, so
nothing is ever quietly dropped.

The ceiling exists because Telegram accepts roughly 20 messages a minute for one group, and a topic
that spends more than that holds up every other session's. The same arithmetic decides who gets the
budget when several turns arrive in one pass: **the newest turn gets all of it and the earlier ones
get one message each**, because the last turn is the one you are about to answer and the ones before
it are context you skim.

### Which turns you get: all of them, and a sample of the machinery

Two rules, because a phone reader wants the two kinds of turn differently.

**Everything spoken is posted.** Every message you send, and every message the agent writes that is
not a tool call. A conversation with holes in it cannot be replied to, so there is no filtering here
— only `sessionSitter.telegram.maxTurnsPerPass` (default 12), a backstop for a genuine burst, and
past it the overflow is *named* rather than dropped:

```
… 26 earlier turns not shown — use Full transcript
```

That number used to be four, fixed, and it was wrong: a pass runs every few seconds, so five turns in
one pass means the session is *talking*, which is exactly what you opened the topic for.

**Tool activity is sampled.** An agent that spends ten minutes editing files says nothing in that
time, and a topic showing nothing at all reads as a session that has stopped — while the panel, which
shows a tool name beside the row, says otherwise about the same session. So one line is posted for
it, at most once per quiet window:

```
🛠 Edit(src/telegram/render.ts) · +6 more tool calls
```

The window is `sessionSitter.telegram.toolActivitySeconds` (default 60) and it is measured from
**anything** posted into the topic, a mirrored turn included: a turn already says the session is
alive, which is the only thing a sample is for. So a talkative session shows no tool lines and a quiet
one shows about one a minute — which is what makes this affordable inside a budget of twenty messages
a minute for the whole group. A sample the window withholds is **not queued**: it is dropped, because
posting it a minute later would report a call that has long since finished as though it were current.
`sessionSitter.telegram.mirrorToolActivity: false` turns the lines off entirely.

### Where mirroring resumes from

A topic's record holds the **identity** of the last turn posted into it, not a count of turns.

The count was the first design and it silently broke every busy session. The transcript reader hands
back the last few turns rather than the whole file, so once a session had produced more turns than
that window holds, the count it was compared against stopped growing — "how many turns exist" and
"how many have been posted" became equal and stayed equal, and the topic went quiet for the rest of
the session while the session itself carried on. Identity survives a window that slides; a count
cannot. Where the anchor has fallen out of the window entirely its timestamp still orders it against
what is in the window, so the turns after it are recovered rather than lost.

Two buttons on the topic header:

- **Full transcript** — uploaded as a Markdown file. A whole transcript is far past Telegram's
  4096-character message cap, so it cannot be a message however it is split.
- **Focus in IDE** — brings the session to the front on its own machine, reusing the same
  cross-window and cross-machine handshake a click in the panel uses.

---

## What can be written to

Reading works everywhere. Writing does not, and the limit is in the agent, not here.

| Agent | Read | Write |
|---|:---:|---|
| **Bob** | ✅ | ✅ Any task, live or historical |
| **Claude** | ✅ | ✅ Sessions open in their own window |
| **Codex** | ✅ | ❌ No message API exists |
| **VS Code Chat** | ✅ | ❌ No message API exists |

A Codex or Chat topic says it is read-only in its header rather than accepting your message and
dropping it.

### The Claude limit, precisely

Session Sitter injects a message by writing to a session's CLI transport. Finding *which* transport
belongs to a given session is done at the moment of sending, in three steps, strongest first.

1. **The surface that owns the session.** Claude's extension maps each session to the tab or sidebar
   showing it, and each of those surfaces owns one channel. Following that link by object identity —
   not by name or by string search — gives the session's own channel. This is the normal case, and it
   works with any number of Claude sessions open in the window.
2. **A channel that names the session id.** No channel does today. The step stays for a future Claude
   build that exposes it.
3. **The only channel open**, where there is nothing to confuse it with.

If none of the three resolves, **nothing is sent** and the topic says so. That is a deliberate
refusal: delivering your prompt to the wrong agent is worse than not delivering it, because the wrong
agent acts on it.

Two cases still refuse, and both come from Claude's own bookkeeping:

- **One surface has shown several sessions.** Claude's session state accumulates — an entry goes only
  when its surface closes, not when the surface switches session — so several sessions can name the
  same owner while only one of them is live. Rather than pick, Session Sitter refuses.
- **A session is not open in its window at all.** There is no channel to write to. Use **Focus in
  IDE** to resume it first, then send.

Routing helps more than it sounds: a command goes to the window that owns the session, so what
matters is that window, not the machine.

Step 1 reads Claude internals that no API promises. Run **Session Sitter: Probe Claude Targeting**
from the command palette to see, per session, which channel a message would land in and by which
step — it writes nothing. After a Claude Code update, that is the check: a window full of
`refused:ambiguous:N` with `hasPanelTab: false` means Claude moved the field, and targeting has
fallen back to refusing rather than guessing.

---

## How it decides which window is responsible

One window owns a session, and only its owner writes to it. Ownership is worked out independently by
every window from the shared window registry, so they agree without coordinating.

1. **A window has it open.** Taken from the live agent state each window already publishes
   (`openClaudeSessionIds`, `openBobTaskIds`). Exact.
2. **Otherwise, the longest containing workspace.** Covers idle and history sessions. This is why a
   session in `<repo>/.claude/worktrees/feat` is owned by the window on the worktree if one is open,
   and by the window on the parent repo if not.
3. **Otherwise, nobody.** The session is read-only, and the topic says which machine it is on.

Ties break on the lowest process id, so every window computes the same owner.

---

## Topics come and go

A topic is created automatically for any session that **needs you or is running** — `approval`,
`question`, `finished` or `working`. The three quiet states get one only when you tap the session in
the list, because auto-creating a topic per historical session would put weeks of them in the sidebar.

The status leads every topic name, so the topic list doubles as a status board. Same amber / green /
grey language as the panel — see [`STATUS-INDICATORS.md`](STATUS-INDICATORS.md):

| Icon | Status | Meaning |
|:---:|---|---|
| 🟠 | `approval` | Paused on a permission prompt — approve or reject |
| ❓ | `question` | Asked you something — answer it |
| 🟢 | `finished` | Done, and you have not read it |
| 🔄 | `working` | Running a tool or writing a reply — nothing to do |
| ⚫ | `seen` | Done, and you have read it |
| ⚪ | `dormant` | Nothing happening, or no signal to tell |

A session's topic is **deleted** as soon as the session leaves the active list. There is no idle
timer: an active session keeps its topic open for as long as it is active. See
[What counts as an active session](#what-counts-as-an-active-session).

### The name is held for a minute, so the group is not a stream of renames

A status is derived from a transcript, and an agent between tool calls leaves `working` and comes back
to it seconds later. Every one of those wrote a rename, and Telegram announces a rename in the thread
— so a single busy session produced a *Name changed* notice every few seconds and drowned out the
sessions that actually needed somebody.

A topic now keeps the name it has for `sessionSitter.telegram.statusHoldSeconds` (default 60) before a
status change is written. It is a cooldown on **writing**, not a wait for the status to settle, and
that distinction is the whole design: waiting for a status to hold steady would delay every rename
by a minute, including the one you are waiting for. A cooldown delays only a rename that follows hard
on the heels of another — which is exactly the flap — so a session that goes `working → seen →
working` inside the window is never renamed at all, because by the time the window is up the name is
already right.

**A status that needs you is never held.** `approval`, `question` and `stalled` are the reason the
topic list is worth reading, so they are written the moment they appear; showing one a minute late
would trade a real cost for a cosmetic one. Set the hold to `0` for the old behaviour.

---

## Two limits worth knowing

**Telegram's rate limit.** A bot may send on the order of 20 messages a minute to one group. A busy
agent produces far more turns than that. So mirroring posts every prompt and every answer, samples
tool activity at one line per quiet minute, and collapses a burst into one line rather than queuing
it:

```
… 26 earlier turns not shown — use Full transcript
🧑 run the tests
🤖 3 failed in sessionSort.test.ts
```

Queuing the burst instead would put the group minutes behind the session, which is worse than saying
what was skipped. See [Which turns you get](#which-turns-you-get-all-of-them-and-a-sample-of-the-machinery).

**`/new` starts the session, names it, and gives it a topic.** `primaryEditor.open` returns no id, so
this used to report only that a window had been opened and promise a topic "once it writes its first
message" — a promise nothing kept. **A panel nobody has spoken to writes no transcript**, and the
worklist is built from transcripts, so the session existed in the IDE and could never be continued from
the phone it was started on.

Two things make it work now. Claude's live manager knows the panel immediately, so `/new` reads the open
sessions before and after opening and learns which one appeared. Then it **sends that session a first
message**, which is what makes the CLI write a transcript and the session real. The id travels back on
the command result, and its topic is created there and then rather than waited for.

Where it cannot be sure, it says so instead of guessing:

| | |
|---|---|
| two sessions appeared at once | it refuses to pick. A first message in the wrong conversation is worse than none, so the panel is left for you to use in the IDE |
| nothing registered within 8s | the panel is open and unnamed; say something to it in the IDE and it appears on the next pass |
| the first message did not land | the session is identified and gets a topic, but nothing is mirrored until it has a transcript. The reason is quoted |

None of those is reported as "could not start" — the panel is open in every one of them, and saying
otherwise sends you looking for a window sitting in front of you.

**Bob is unchanged**, and still cannot be confirmed: `startTask` returns nothing and its tasks live in a
SQLite store this window does not read synchronously. Its topic still appears a poll or two later.

### Which workspace it opens in

The menu offers one button per workspace folder, and pairs each folder with the window most likely to
honour it — **a window that has that folder and only that folder**. That matters because nothing in
Claude's API takes a folder: `primaryEditor.open` accepts a session id and nothing else, so in a
multi-root window Claude picks the folder itself.

This is a fix, not a refinement. The menu used to pair a folder with *whichever window listed it first*,
so a multi-root window would capture folders that had a dedicated window of their own — and tapping one
opened a session that reported a different workspace, silently. Where no single-folder window exists the
folder is still offered, with the caveat said **before** you tap:

```
Start a new session where?

Some folders cannot be guaranteed:
· app: that window also has other, third open, and Claude picks the folder itself — the session may
  land in one of those instead
```

Warned before rather than after, because once the session exists in the wrong folder the only remedy is
to close it and start again.

---

## When something does not work

Every failure is stated in the topic. Silence is never the answer. If it is, check these.

| Symptom | Cause |
|---|---|
| Commands work, typed text does nothing | Privacy mode is still on for the bot. `/setprivacy` → Disable. |
| Nothing happens at all | `allowedUserIds` is empty, or your id is not in it. The Output panel logs each rejected id. |
| "Topics are not enabled in this group" | The chat is a group without Topics, or a channel. Enable Topics. |
| Messages reach the wrong machine, or vanish | Two machines share a bot token. Give each its own. |
| `⚠ No open window is responsible for that session` | Its workspace has no window open. Open it. |
| `⚠ Could not tell which of the N Claude sessions…` | The Claude limit above. Focus the session, then send again; **Probe Claude Targeting** says why. |
| Topics stop updating after a window closes | Another window takes over reading within about 30 seconds. |

The Output panel (*Session Sitter*) and `<stateDir>/session-sitter.log` carry the detail.

---

## Alongside supervision

Both features share the group, and the remote interface makes supervision better in two ways.

**A decision card lands in its session's topic**, beside the conversation it is about, instead of in
one shared feed where you had to read each card's session line to tell them apart. Answer it there —
tap a button or reply with text — exactly as before.

**Windows no longer fight over your replies.** Every window with supervision on used to poll Telegram
with the same token and one shared offset file, so replies were already being split between windows at
random. It mostly worked, but a Claude decision could be applied to the wrong session. Now one window
per machine reads, and a reply is routed to the window that owns the session it concerns.

You do not have to configure any of this. It follows from turning the interface on.

---

## Where the state lives

Beside the existing window registry, under your home directory:

```
~/.claude/session-sitter/
  windows/<pid>.json     which sessions each window has open  (already existed)
  bus/telegram.lock      the lease: which window reads Telegram
  bus/cmd/, bus/res/     commands to the owning window, and their outcomes
  bus/topics/<id>.json   session ↔ topic, and how far mirroring got
```

Nothing here is secret and all of it is disposable — deleting it costs you the topic mapping, and new
topics are created on the next pass.

---

## See also

- [`CONFIGURATION.md`](CONFIGURATION.md#telegram-remote-control) — every setting
- [`SUPERVISION.md`](SUPERVISION.md) — decision cards, which post into their own session's topic
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit
