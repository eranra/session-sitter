/**
 * Everything the remote-control feature shows a human, as pure functions.
 *
 * Kept free of network and filesystem on purpose. The Telegram surface is the part most likely to
 * be wrong in a way only a person notices — a truncated title, a list that reflows every poll, a
 * transcript that floods the group — and pure render functions are the only part of that which a
 * test can hold still. `telegram.ts` already follows this split (`buildCard` is pure and tested);
 * this continues it.
 *
 * ## The limits that shape these functions
 *
 * Telegram is not a terminal, and three of its limits are load-bearing here:
 *
 *  - A message body caps at 4096 characters. A whole transcript is far larger, so it is never a
 *    message — that is what the file upload is for. A single **turn** is a different matter: it is
 *    the thing you have to read in order to answer, so it is split across as many messages as it
 *    needs (`splitMessages`) rather than cut off. Truncation is left to the surfaces that are
 *    re-rendered every pass — the fleet list, the topic header — where the tail carries nothing.
 *  - A forum topic name caps at 128 characters.
 *  - A bot may send on the order of 20 messages per minute to one group. A busy agent produces
 *    far more turns than that, so mirroring *must* drop and summarise rather than queue. Queuing
 *    would put the group minutes behind the session, which is worse than saying "12 turns not
 *    shown".
 */

import type { ClaudeSession } from '../SessionManager';
import type { MessageExchange } from '../SessionManager';
import { needsYou, type SessionStatus } from '../sessionStatus';
import type { Ownership } from './ownership';

/** Telegram's message body limit. */
export const MAX_MESSAGE_CHARS = 4096;
/** Telegram's forum topic name limit. */
export const MAX_TOPIC_NAME_CHARS = 128;
/**
 * Spoken turns posted per mirror pass, per topic, by default. Overflow collapses into one line.
 *
 * A backstop against Telegram's rate limit, and no longer a policy. It used to be four, which made
 * the mirror drop turns on any pass that saw five — and since a pass runs every few seconds, five
 * turns in one pass means the session is *saying* things, which is exactly what a reader is there
 * for. Twelve is high enough that only a genuine burst reaches it and low enough that one topic
 * cannot spend the whole group's minute. See `sessionSitter.telegram.maxTurnsPerPass`.
 */
export const MAX_TURNS_PER_PASS_DEFAULT = 12;
/**
 * The most turns one pass may ever be asked to post.
 *
 * Well past Telegram's ~20-a-minute allowance for one group, because past that point the limit is
 * enforced by Telegram either way and the honest thing is to let the setting say what it means.
 */
export const MAX_TURNS_PER_PASS_LIMIT = 50;
/** How long a tool sample waits after anything else was posted, by default. */
export const TOOL_SAMPLE_SECONDS_DEFAULT = 60;
/** How long a topic name is held at its last value before a status change is written, by default. */
export const STATUS_HOLD_SECONDS_DEFAULT = 60;
/** Messages one turn may be split into, by default. See `sessionSitter.telegram.maxMessageParts`. */
export const MAX_MESSAGE_PARTS_DEFAULT = 4;
/**
 * The most parts the setting may ask for.
 *
 * 20 is Telegram's own per-minute allowance for one group, so a single turn is never permitted to
 * spend more than a minute's worth of the group's budget however the setting is turned up.
 */
export const MAX_MESSAGE_PARTS_LIMIT = 20;

/**
 * Room held back on the final part for the "there was more" pointer.
 *
 * A fixed reserve rather than a fitted one: the pointer's length depends on the number of
 * characters dropped, which depends on where the cut lands, which depends on the reserve. Sizing it
 * once for the longest pointer anyone will ever see breaks the circle and costs a few characters of
 * a 4096-character message.
 */
const POINTER_RESERVE = 64;

/**
 * One glyph per status, matched as closely to the panel's marker as characters allow.
 *
 * Telegram renders no shapes, only text, so what carries over from `docs/STATUS-INDICATORS.md` is
 * the colour language and the silhouette. Amber means your turn, green means the agent's, grey
 * means nothing is happening:
 *
 * | Status     | Panel marker          | Here | Why this character                                |
 * |------------|-----------------------|------|---------------------------------------------------|
 * | `approval` | solid amber triangle  | 🟠   | Amber and filled — the most solid thing in a list |
 * | `question` | amber question mark   | ❓   | The one symbol that needs no learning             |
 * | `finished` | green dot in a ring   | 🟢   | Green and filled — a result waiting to be read    |
 * | `working`  | spinning green ring   | 🔄   | The only glyph in the set that reads as motion    |
 * | `seen`     | small flat grey dot   | ⚫   | Filled and quiet — present, asking for nothing    |
 * | `dormant`  | hollow grey circle    | ⚪   | Hollow, so it is a different shape from `seen`    |
 *
 * The icon leads every row and every topic name, so it is the first thing read in a list of twenty:
 * `approval` and `question` have to be distinguishable from each other at a glance, because one
 * needs a tap and the other needs typing. The whole set is pinned by a test, so changing one is a
 * deliberate act rather than a silent drift away from the panel.
 */
const STATUS_ICON: Record<SessionStatus, string> = {
  approval: '🟠',
  question: '❓',
  finished: '🟢',
  working: '🔄',
  // Red, not amber: amber means "your turn" everywhere in this set, and a stall is not your turn —
  // there is nothing to tap. It is the one glyph reporting a fault rather than a turn.
  stalled: '🔴',
  seen: '⚫',
  dormant: '⚪',
};

const SOURCE_LABEL: Record<ClaudeSession['source'], string> = {
  claude: 'claude',
  bob: 'bob',
  codex: 'codex',
  chat: 'chat',
};

export function statusIcon(status: SessionStatus): string {
  return STATUS_ICON[status] ?? '⚪';
}

/**
 * How a session is named wherever it is named: `workspace / title · agent[@host]`.
 *
 * The order is not cosmetic. The workspace answers "which piece of work is this?", which is the
 * question actually being asked when twenty rows go past — so it comes first, and it is never the
 * part that gets truncated. The title distinguishes two sessions in that workspace. Which agent it
 * is, and which machine it runs on, are worth knowing but never worth reading first, so they trail.
 *
 * The host is shown only for a peer session: on this machine it would be noise on every row.
 */
export function sessionLabel(session: ClaudeSession, titleChars: number): string {
  const agent = session.peer
    ? `${SOURCE_LABEL[session.source]}@${session.peer}`
    : SOURCE_LABEL[session.source];
  return `${session.projectName} / ${truncate(session.title, titleChars)} · ${agent}`;
}

/** Cut `text` to `max` characters on a word boundary where one is close enough to the end. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) { return clean; }
  const hard = clean.slice(0, Math.max(0, max - 1));
  const lastSpace = hard.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${body}…`;
}

/** Human-readable age, in the compact form the session panel uses. */
export function relativeAge(updatedAt: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt.getTime()) / 1000));
  if (seconds < 45) { return 'now'; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.round(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.round(hours / 24)}d`;
}

/**
 * The name of a session's topic: `🟠 workspace / title · claude`.
 *
 * The status icon leads so the topic list doubles as a status board — Telegram shows topic names in
 * a sidebar, and an icon there is the cheapest possible "what needs me" signal. Everything after it
 * follows `sessionLabel`: workspace, title, then the agent and the machine.
 *
 * The title is what gets truncated, never the workspace, because two topics from the same workspace
 * still have to be told apart by title.
 */
export function topicName(session: ClaudeSession): string {
  const icon = `${statusIcon(session.status)} `;
  // What the name costs before a single character of title: the icon, the workspace, the separators
  // and the agent. Measured rather than guessed, so a long workspace or an `agent@host` cannot push
  // the result past Telegram's limit.
  const overhead = icon.length + sessionLabel({ ...session, title: '' }, 0).length;
  const room = MAX_TOPIC_NAME_CHARS - overhead;
  if (room < 8) {
    return truncate(`${icon}${session.projectName}`, MAX_TOPIC_NAME_CHARS);
  }
  return truncate(`${icon}${sessionLabel(session, room)}`, MAX_TOPIC_NAME_CHARS);
}

export interface ListEntry {
  session: ClaudeSession;
  owner: Ownership;
}

/** Sort rows by workspace, then title. Never by time — see `renderFleetList`. */
function byWorkspaceThenTitle(a: ListEntry, b: ListEntry): number {
  const ws = a.session.projectName.localeCompare(b.session.projectName);
  return ws !== 0 ? ws : a.session.title.localeCompare(b.session.title);
}

/** One list row: `🟠 workspace / title · claude · 2m · read-only`. */
function listRow(entry: ListEntry, now: number): string {
  const { session, owner } = entry;
  const readOnly = owner.pid === null ? ' · read-only' : '';
  return `${statusIcon(session.status)} ${sessionLabel(session, 40)}`
    + ` · ${relativeAge(session.updatedAt, now)}${readOnly}`;
}

/**
 * The General topic's one live message: the **active** sessions, exactly the panel's worklist.
 *
 * Active-only, not everything the machine can see. A fleet accumulates hundreds of past sessions,
 * and a list of hundreds answers no question — you cannot find the one that needs you in it. The
 * rule for what counts as active is `sessionActivity.ts`, shared with the panel, so this list and
 * the panel's cannot disagree. Everything else is behind `/history`.
 *
 * Sorted by workspace and then title, **never** by time, because this message is *edited in place*:
 * a time ordering would reshuffle every row on every poll and be impossible to read. A row moves
 * only when a session appears, disappears, or changes status.
 *
 * The host is not a heading here. It used to group the list, which put the machine name above the
 * workspace — and the machine is the last thing you need when you are looking for a piece of work.
 * It now trails inside each row, and only for a session on another machine.
 */
export function renderFleetList(
  entries: ListEntry[], hostname: string, now: number,
): string {
  // Counted by what they ask of you, not by internal state name: "needs you" is the number you act
  // on, and it is the only figure worth reading at the top of a list of twenty.
  const yours = entries.filter(e => needsYou(e.session.status)).length;
  const running = entries.filter(e => e.session.status === 'working').length;

  const header = `Session Sitter · ${hostname}`;
  const counts = `${yours} need you · ${running} working · ${entries.length} active`;
  if (entries.length === 0) {
    return `${header}\n${counts}\n\nNo active sessions. /history shows the earlier ones.`;
  }

  const lines = [header, counts, ''];
  for (const entry of entries.slice().sort(byWorkspaceThenTitle)) {
    lines.push(`  ${listRow(entry, now)}`);
  }
  return truncate2(lines.join('\n'));
}

/**
 * A fingerprint of what the list says, ignoring anything that changes on its own.
 *
 * The pinned General message is edited in place, and Telegram rate-limits edits. Ages ("2m") tick
 * every pass, so treating the rendered body as the comparison would mean an edit every few seconds
 * carrying no new information. What actually matters is which sessions exist, what state each is in,
 * and whether it can be written to — so that, and only that, is what the fingerprint covers.
 *
 * Sorted, because the caller may hand these over in any order and a reordering is not a change.
 */
export function fleetSignature(entries: ListEntry[]): string {
  return entries
    .map(e => `${e.session.sessionId}:${e.session.status}:${e.owner.pid ?? 'none'}`)
    .sort()
    .join('|');
}

/**
 * `/history` — the sessions the worklist does not show, newest first.
 *
 * Newest first, unlike the active list, and for the opposite reason: this message is posted fresh
 * each time rather than edited in place, so nothing reshuffles under you, and "what was I last
 * working on?" is the actual question a history list is asked.
 */
export function renderHistoryList(
  entries: ListEntry[], now: number,
): string {
  if (entries.length === 0) {
    return 'No earlier sessions — everything this machine can see is already in the active list.';
  }
  const lines = [
    `History · ${entries.length} session${entries.length === 1 ? '' : 's'}`,
    'Tap one to open its topic and bring it back into the active list.',
    '',
  ];
  for (const entry of entries) {
    lines.push(`  ${listRow(entry, now)}`);
  }
  return truncate2(lines.join('\n'));
}

/**
 * Trim a whole message to Telegram's body limit, keeping the start.
 *
 * Distinct from `truncate`: this works on multi-line bodies and must not collapse whitespace,
 * because the layout is the information.
 */
export function truncate2(body: string): string {
  if (body.length <= MAX_MESSAGE_CHARS) { return body; }
  const keep = MAX_MESSAGE_CHARS - 40;
  return `${body.slice(0, keep)}\n… truncated`;
}

/**
 * The message posted when a topic is created: what this session is, and what can be done to it.
 *
 * Same reading order as every other surface — workspace, then title, then the agent and the machine
 * — so the header confirms what the topic name already said instead of restating it differently.
 */
export function renderTopicHeader(
  session: ClaudeSession, owner: Ownership, blockedReason: string | null,
): string {
  const lines = [
    `${statusIcon(session.status)} ${session.projectName}`,
    session.title,
    '',
    `agent: ${SOURCE_LABEL[session.source]}`,
    `host: ${session.peer ?? 'this machine'}`,
    `path: ${session.projectPath}`,
    `session: ${session.sessionId}`,
  ];
  if (owner.pid !== null) {
    // Named for what it is. Calling the daemon a "window" would tell a reader they can type here,
    // which is the one thing a daemon-held session cannot do.
    lines.push(owner.basis === 'daemon'
      ? `daemon: pid ${owner.pid} (no IDE window here)`
      : `window: pid ${owner.pid} (${owner.basis === 'holds' ? 'has it open' : 'owns the workspace'})`);
  }
  lines.push('');
  lines.push(blockedReason === null
    ? 'Type here to send a message to this session.'
    : `⚠ ${blockedReason}`);
  return truncate2(lines.join('\n'));
}

/**
 * Where to cut `text` so the first piece is at most `limit` characters and still readable.
 *
 * Boundaries in preference order — paragraph, line, word — and a hard cut only when none of them
 * lands late enough to be worth taking. The `0.5` floor is what stops a boundary near the start
 * from turning a 4000-character part into a 200-character one and spending a message on it: an
 * early newline is a worse cut than a clean word break at the end.
 */
function cutAt(text: string, limit: number): number {
  if (text.length <= limit) { return text.length; }
  const window = text.slice(0, limit);
  const floor = limit * 0.5;
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(sep);
    if (at > floor) { return at; }
  }
  return limit;
}

/** How many characters the separator at a cut point occupies, so it is not duplicated. */
function separatorWidth(text: string, at: number): number {
  if (text.startsWith('\n\n', at)) { return 2; }
  if (text.startsWith('\n', at) || text.startsWith(' ', at)) { return 1; }
  return 0;
}

/**
 * Split one body into as many Telegram messages as it needs, up to `maxParts`.
 *
 * This is the function the feature exists for. Telegram caps a message at 4096 characters, and the
 * mirror used to answer that by cutting the text off — which is fine for a list that is re-rendered
 * every pass and useless for an agent's answer, because the part you need in order to reply is
 * usually the end. So a long body becomes several messages instead of one short one.
 *
 * `lead` is the speaker icon, repeated on every part: Telegram renders each message as its own
 * bubble, so a continuation with no icon reads as though someone else said it.
 *
 * Numbering (`(2/5)`) appears only when there is more than one part, because it would otherwise be
 * noise on the overwhelming majority of turns. It is written into the body rather than being
 * inferred from message order for a reason: a mirror pass can interleave turns from several
 * sessions, and a retry after a rate limit can arrive out of order.
 *
 * When the body outruns the budget the last part ends with the exact number of characters not
 * shown, and points at the transcript upload — a count is actionable ("that answer was three times
 * what I got") where a bare ellipsis is not.
 */
export function splitMessages(lead: string, body: string, maxParts: number): string[] {
  const text = body.trim();
  const parts = Math.max(1, Math.floor(maxParts));
  if (lead.length + text.length <= MAX_MESSAGE_CHARS) { return [`${lead}${text}`]; }

  // Held back on every part, numbered or not, so a part's tag cannot push it past the limit.
  const tag = `(${parts}/${parts}) `.length;
  const limit = MAX_MESSAGE_CHARS - lead.length - tag;

  const bodies: string[] = [];
  let rest = text;
  while (rest.length > 0 && bodies.length < parts) {
    const last = bodies.length === parts - 1;
    // On the final allowed part, take the whole remainder when it fits: reserving pointer room
    // unconditionally would leave a few characters over and report "… 12 more characters" on a
    // body that had actually finished.
    if (last && rest.length > limit) {
      const at = cutAt(rest, limit - POINTER_RESERVE);
      bodies.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at + separatorWidth(rest, at));
      break;
    }
    const at = cutAt(rest, limit);
    bodies.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at + separatorWidth(rest, at));
  }

  const total = bodies.length;
  const out = bodies.map((part, i) => (total === 1
    ? `${lead}${part}`
    : `${lead}(${i + 1}/${total}) ${part}`));
  if (rest.length > 0) {
    out[out.length - 1]
      += `\n… ${rest.length} more characters — use 📄 Full transcript`;
  }
  return out;
}

/**
 * One mirrored transcript turn, as the messages it takes to say it.
 *
 * `maxParts` defaults to 1, which keeps the single-message-per-turn shape the mirror had before
 * splitting existed — so a caller that has not opted in is unaffected.
 */
export function renderTurn(turn: MessageExchange, maxParts = 1): string[] {
  // A third glyph for tool activity, because it is a different *kind* of thing from a spoken turn:
  // 🤖 means the agent said something to you, 🛠 means it did something. Reusing 🤖 for both would
  // make a sampled tool line read as an answer that had been cut short.
  const icon = turn.kind === 'tool' ? '🛠' : turn.role === 'user' ? '🧑' : '🤖';
  return splitMessages(`${icon} `, turn.text, maxParts);
}

/**
 * How far mirroring has got in one topic.
 *
 * A **count** was the first design and it is wrong, because the transcript reader returns a sliding
 * window of the last few turns rather than the whole file. Once a session had produced as many turns
 * as that window holds, `turns.length` stopped growing while the cursor stayed equal to it — so
 * `turns.length <= cursor` was true on every pass thereafter and the topic went silent for the rest
 * of the session. That is the "nothing is being reported" this cursor replaces.
 *
 * The fix is to anchor on the *identity* of the last posted turn instead. Identity survives a window
 * that slides, which a count cannot.
 */
export interface MirrorCursor {
  /** `turnKey` of the last turn posted, or absent when nothing has been. */
  key?: string;
  /** How many turns have been posted in total. Kept for the log line, and for legacy records. */
  count: number;
}

export interface MirrorPlan {
  /** Messages to post, in order. */
  messages: string[];
  /** New cursor to persist once every message is posted. */
  nextCursor: MirrorCursor;
}

export interface MirrorOptions {
  /** Messages the newest turn of a pass may be split into. 1 is the old truncating behaviour. */
  maxParts?: number;
  /**
   * Text this window recently injected, so the mirror does not echo the user's own prompt back.
   *
   * Compared here, against the turn, rather than against the rendered message: a prompt long enough
   * to be split carries a `(1/2)` tag and a speaker icon, and would never match what was sent.
   */
  recentlySent?: string[];
  /** Spoken turns one pass may post before the overflow collapses into a line. */
  maxTurns?: number;
  /** Post sampled tool activity at all. Off means spoken turns only, as the mirror used to be. */
  mirrorTools?: boolean;
  /**
   * How quiet a topic has to have been before one tool line is sampled into it. 0 samples every pass.
   */
  toolSampleMs?: number;
  /** When the topic was last posted into, and now — the two ends of the quiet window. */
  lastPostedAt?: number;
  now?: number;
}

/**
 * The identity of one turn, stable across reads of the same transcript.
 *
 * Built from the timestamp, the speaker, the kind and the shape of the text rather than from an id,
 * because a transcript turn has no id — the record does, but the reader collapses several records
 * into one turn. The timestamp leads so that a key whose turn has fallen out of the read window can
 * still be *compared* against the turns that are in it; `freshTurns` relies on that.
 *
 * Only a prefix of the text takes part. Full mode and preview mode return the same turn at different
 * lengths, so a key over the whole body would change when `fullMessages` is toggled and re-post the
 * tail of the conversation; a prefix plus the length is enough to tell two turns apart.
 */
export function turnKey(turn: MessageExchange): string {
  const body = turn.text.replace(/\s+/g, ' ').trim();
  return [
    turn.timestamp ?? '', turn.role, turn.kind ?? 'text', body.length, body.slice(0, 32),
  ].join('|');
}

/** The timestamp a key was built from, or undefined when the turn had none. */
function timestampOfKey(key: string): string | undefined {
  const stamp = key.split('|')[0];
  return stamp.length > 0 ? stamp : undefined;
}

/**
 * The turns that have arrived since the cursor was written.
 *
 * Three cases, and the order matters:
 *
 *  1. **The anchor is in the window.** Everything after it is new. The normal case.
 *  2. **The anchor has fallen out of the window**, because the session produced more turns between
 *     two passes than the reader returns. Its timestamp still orders it against what *is* in the
 *     window, so the turns newer than it are recovered rather than lost.
 *  3. **There is no anchor** — a legacy record, or a topic created before anything was posted. The
 *     count is all there is, so it is used exactly as it used to be, and the next pass has a key.
 *
 * Where no comparison is possible at all the answer is "nothing new". Skipping a turn costs one line
 * in a topic; guessing the other way re-posts a conversation.
 */
function freshTurns(turns: MessageExchange[], cursor: MirrorCursor): MessageExchange[] {
  if (cursor.key === undefined) {
    return turns.slice(Math.min(Math.max(0, cursor.count), turns.length));
  }
  const at = turns.findIndex(turn => turnKey(turn) === cursor.key);
  if (at >= 0) { return turns.slice(at + 1); }
  const since = timestampOfKey(cursor.key);
  if (since === undefined) { return []; }
  return turns.filter(turn => turn.timestamp !== undefined && turn.timestamp > since);
}

/** The cursor to persist after consuming `fresh` out of `turns`. */
function cursorAfter(
  turns: MessageExchange[], cursor: MirrorCursor, fresh: MessageExchange[],
): MirrorCursor {
  const last = turns[turns.length - 1];
  return {
    key: last === undefined ? cursor.key : turnKey(last),
    count: Math.max(0, cursor.count) + fresh.length,
  };
}

/**
 * One line standing for the tool calls a session made while it had nothing to say.
 *
 * The newest call, because it is the one still running, plus a count of the ones behind it. A session
 * that spends ten minutes editing files says nothing in that time, and a topic that shows nothing at
 * all reads as a session that has stopped — this is the smallest thing that distinguishes "working"
 * from "dead" without turning the group into a tool log.
 */
export function renderToolSample(tools: MessageExchange[]): string[] {
  const newest = tools[tools.length - 1];
  const behind = tools.length - 1;
  const suffix = behind > 0 ? ` · +${behind} more tool call${behind === 1 ? '' : 's'}` : '';
  return renderTurn({ ...newest, text: `${newest.text}${suffix}` }, 1);
}

/**
 * Decide what to post into a topic given the transcript and how far mirroring got.
 *
 * ## Everything spoken, and a sample of everything else
 *
 * The two kinds of turn are treated differently on purpose, because a person reading a topic on a
 * phone wants them differently:
 *
 *  - **Spoken turns** — what you typed, and what the agent answered — are all posted. These are the
 *    conversation, and a conversation with holes in it cannot be replied to. Only a genuine burst
 *    past `maxTurns` collapses, and then the overflow is *named* rather than dropped silently.
 *  - **Tool activity** is sampled: at most one line, and only into a topic that has been quiet for
 *    `toolSampleMs`. A busy session makes hundreds of tool calls a minute, so posting them is not a
 *    matter of taste but of Telegram's ~20-messages-a-minute limit — a session that spent it on tool
 *    calls would hold up every other session's turns. One line a minute is enough to see that the
 *    agent is working and on what; the transcript has the rest.
 *
 * A pass that posts a spoken turn posts no sample: the turn already said the session is alive, which
 * is the only thing a sample is for.
 *
 * ## Who gets the parts budget
 *
 * Splitting long turns and posting several of them pull against each other: four turns at four parts
 * each is sixteen messages, most of a minute's allowance for the whole group. So the budget is not
 * shared out evenly — **the newest turn of the pass gets all of it, and the older ones get one part
 * each.** When several turns arrive together the last is the one being answered, and the earlier ones
 * are context you skim.
 */
export function planMirror(
  turns: MessageExchange[], cursor: MirrorCursor | number, opts: MirrorOptions = {},
): MirrorPlan {
  // A bare number is the count-only anchor, which is what a record written before keys existed
  // holds, and what most callers pass in a test.
  const from: MirrorCursor = typeof cursor === 'number' ? { count: cursor } : cursor;
  const fresh = freshTurns(turns, from);
  if (fresh.length === 0) { return { messages: [], nextCursor: cursorAfter(turns, from, fresh) }; }

  const maxParts = Math.max(1, Math.floor(opts.maxParts ?? 1));
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns ?? MAX_TURNS_PER_PASS_DEFAULT));
  const spoken = fresh.filter(turn => turn.kind !== 'tool');
  const tools = fresh.filter(turn => turn.kind === 'tool');

  const skipped = Math.max(0, spoken.length - maxTurns);
  const shown = skipped > 0 ? spoken.slice(-maxTurns) : spoken;
  const messages: string[] = skipped > 0
    ? [`… ${skipped} earlier turn${skipped === 1 ? '' : 's'} not shown — use Full transcript`]
    : [];
  const sent = opts.recentlySent ?? [];
  for (const [i, turn] of shown.entries()) {
    // A prompt sent from Telegram comes back as a user turn. It is already on screen as the
    // sender's own message, so reposting it reads as a duplicate send. The cursor still advances.
    if (turn.role === 'user' && isEchoOfSent(turn.text, sent)) { continue; }
    const newest = i === shown.length - 1;
    messages.push(...renderTurn(turn, newest ? maxParts : 1));
  }

  if (messages.length === 0 && tools.length > 0 && opts.mirrorTools === true) {
    const quietFor = (opts.now ?? 0) - (opts.lastPostedAt ?? 0);
    if (quietFor >= (opts.toolSampleMs ?? 0)) { messages.push(...renderToolSample(tools)); }
  }

  // The cursor advances past every fresh turn, sampled tool calls included. They are a sample, not a
  // queue: holding an unsampled call back would post it a minute late as though it were current.
  return { messages, nextCursor: cursorAfter(turns, from, fresh) };
}

/**
 * True when `text` is one this window just injected, so the mirror must not echo it back.
 *
 * A prompt sent from Telegram reappears as a user turn in the transcript, and reposting it makes
 * the topic read as though the message was sent twice. Matched on trimmed text rather than an id
 * because the transcript keeps no record of where a message came from.
 */
export function isEchoOfSent(text: string, recentlySent: string[]): boolean {
  const needle = text.replace(/\s+/g, ' ').trim();
  if (!needle) { return false; }
  return recentlySent.some(sent => sent.replace(/\s+/g, ' ').trim() === needle);
}

/** The `/help` body. Lists only what this build can actually do. */
export function renderHelp(): string {
  return [
    'Session Sitter — remote control',
    '',
    'In this topic (General):',
    '  /sessions   refresh the list of active sessions',
    '  /history    the earlier ones — tap to bring one back',
    '  /new        start a session in a workspace on this machine',
    '  /who        show which window owns what',
    '  /help       this message',
    '',
    'The list holds the active sessions only, the same ones the Sessions panel shows.',
    'A session that leaves that list has its topic deleted; the transcript on disk is kept,',
    'and /history builds a fresh topic from it.',
    '',
    'In a session topic:',
    '  type anything   sent to that session as a user message',
    '  /forget         delete this topic',
    '',
    'Use /forget on a leftover thread. A topic is only tracked while its record exists, and',
    'Telegram gives a bot no way to list a group\'s topics, so one whose record was lost cannot',
    'be tidied up automatically — typing in it is the only thing that still identifies it.',
    '',
    'Read works for Claude, Bob, Codex and Chat sessions.',
    'Writing works for Bob, and for Claude sessions open in their window.',
    'Codex and Chat expose no message API, so they are read-only.',
  ].join('\n');
}

/** `/who` — the ownership table, so a read-only session can be explained rather than guessed at. */
export function renderWho(entries: ListEntry[], hostname: string): string {
  if (entries.length === 0) { return 'No sessions found.'; }
  const lines = [`Ownership on ${hostname}`, ''];
  for (const { session, owner } of entries) {
    const who = owner.pid === null
      ? 'nobody — read-only'
      : owner.basis === 'daemon'
        ? `pid ${owner.pid} · daemon, mirror only`
        : `pid ${owner.pid} · ${owner.basis === 'holds' ? 'has it open' : 'owns workspace'}`;
    lines.push(`${statusIcon(session.status)} ${sessionLabel(session, 30)} → ${who}`);
  }
  return truncate2(lines.join('\n'));
}
