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
/** Turns posted per mirror pass, per topic. Overflow collapses into one summary line. */
export const MAX_TURNS_PER_PASS = 4;
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
  const icon = turn.role === 'user' ? '🧑' : '🤖';
  return splitMessages(`${icon} `, turn.text, maxParts);
}

export interface MirrorPlan {
  /** Messages to post, in order. */
  messages: string[];
  /** New cursor value to persist once every message is posted. */
  nextCursor: number;
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
}

/**
 * Decide what to post into a topic given the transcript and how far mirroring got.
 *
 * The cap is the point of this function. When a session produces 30 turns between passes, posting
 * all 30 would blow the group's rate limit and push everything else minutes behind. So the most
 * recent `MAX_TURNS_PER_PASS` are posted and the rest are acknowledged in one line — the cursor
 * still advances past all of them, because the skipped turns are in the transcript the user can
 * fetch, and pretending otherwise would replay them forever.
 *
 * ## Who gets the parts budget
 *
 * Splitting long turns and capping turns per pass pull against each other: four turns at four parts
 * each is sixteen messages, most of a minute's allowance for the whole group. So the budget is not
 * shared out evenly — **the newest turn of the pass gets all of it, and the older ones get one part
 * each.** When several turns arrive together the last is the one being answered, and the earlier
 * ones are context you skim. That holds the worst case to `MAX_TURNS_PER_PASS - 1` plus the budget,
 * and spends the messages on the text that is actually about to be read.
 *
 * The cursor counts **turns**, never messages, so a turn that took five messages is still one step
 * — counting messages would leave the cursor short and replay the tail of every long answer.
 */
export function planMirror(
  turns: MessageExchange[], cursor: number, opts: MirrorOptions = {},
): MirrorPlan {
  if (turns.length <= cursor) { return { messages: [], nextCursor: turns.length }; }
  const maxParts = Math.max(1, Math.floor(opts.maxParts ?? 1));
  const fresh = turns.slice(cursor);
  const skipped = Math.max(0, fresh.length - MAX_TURNS_PER_PASS);
  const shown = skipped > 0 ? fresh.slice(-MAX_TURNS_PER_PASS) : fresh;

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
  return { messages, nextCursor: turns.length };
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
