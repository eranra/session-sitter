import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_PARTS_DEFAULT,
  MAX_MESSAGE_PARTS_LIMIT,
  MAX_TOPIC_NAME_CHARS,
  MAX_TURNS_PER_PASS_DEFAULT,
  isEchoOfSent,
  planMirror,
  renderToolSample,
  turnKey,
  relativeAge,
  fleetSignature,
  renderFleetList,
  renderHelp,
  renderHistoryList,
  renderTopicHeader,
  renderTurn,
  renderWho,
  sessionLabel,
  splitMessages,
  statusIcon,
  topicName,
  truncate,
  truncate2,
} from '../../telegram/render';
import type { ClaudeSession, MessageExchange } from '../../SessionManager';
import { SESSION_STATUSES, type SessionStatus } from '../../sessionStatus';
import type { Ownership } from '../../telegram/ownership';

const NOW = new Date('2026-09-01T12:00:00Z').getTime();

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    projectName: 'app',
    projectPath: '/work/app',
    title: 'fix the sort order',
    updatedAt: new Date(NOW - 120_000),
    status: 'approval',
    source: 'claude',
    ...over,
  };
}

const owned: Ownership = { pid: 100, basis: 'holds', workspace: '/work/app' };
const unowned: Ownership = { pid: null, basis: 'none', workspace: '' };

describe('statusIcon', () => {
  it('covers every status the codebase defines', () => {
    // A status added later must not silently render as the fallback glyph.
    for (const status of SESSION_STATUSES) {
      expect(statusIcon(status), status).toBeTruthy();
    }
  });

  it('gives each status a distinct icon', () => {
    // The icon leads every row and topic name, so two states sharing one would be unreadable —
    // `approval` needs a tap and `question` needs typing, and they must not look alike.
    const icons = new Set(SESSION_STATUSES.map(statusIcon));
    expect(icons.size).toBe(SESSION_STATUSES.length);
  });

  it('keeps the panel\u2019s colour language, glyph for glyph', () => {
    // Pinned so a change is a deliberate act rather than a drift away from the panel: the whole
    // point of the icon is that amber means your turn wherever you read it. The table in
    // `render.ts` and `docs/STATUS-INDICATORS.md` describe this same mapping.
    const expected: Record<SessionStatus, string> = {
      approval: '\u{1F7E0}',
      question: '\u2753',
      finished: '\u{1F7E2}',
      working: '\u{1F504}',
      stalled: '\u{1F534}',
      seen: '\u26AB',
      dormant: '\u26AA',
    };
    for (const status of SESSION_STATUSES) {
      expect(statusIcon(status), status).toBe(expected[status]);
    }
  });
});

describe('sessionLabel', () => {
  it('leads with the workspace, then the title, then the agent', () => {
    // The workspace answers "which piece of work is this?", which is the question a list of twenty
    // rows is actually asked. The agent is worth knowing and never worth reading first.
    expect(sessionLabel(session(), 40)).toBe('app / fix the sort order \u00b7 claude');
  });

  it('names the machine only for a session on another one', () => {
    expect(sessionLabel(session({ peer: 'me@laptop2' }), 40)).toContain('claude@me@laptop2');
    expect(sessionLabel(session(), 40)).not.toContain('@');
  });

  it('truncates the title and never the workspace', () => {
    const label = sessionLabel(session({ title: 'z'.repeat(200) }), 10);
    expect(label.startsWith('app / ')).toBe(true);
    expect(label.endsWith('\u00b7 claude')).toBe(true);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('collapses runs of whitespace', () => {
    expect(truncate('a   b\n\nc', 20)).toBe('a b c');
  });

  it('never exceeds the limit', () => {
    expect(truncate('x'.repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  it('breaks on a word boundary when one is near the end', () => {
    expect(truncate('alpha beta gamma', 12)).toBe('alpha beta…');
  });

  it('cuts mid-word rather than losing most of the text', () => {
    // A single long word has no usable boundary; dropping it entirely would be worse.
    expect(truncate('supercalifragilistic', 10)).toBe('supercali…');
  });
});

describe('relativeAge', () => {
  it('reads as "now" for something very recent', () => {
    expect(relativeAge(new Date(NOW - 5_000), NOW)).toBe('now');
  });

  it('steps up through minutes, hours and days', () => {
    expect(relativeAge(new Date(NOW - 120_000), NOW)).toBe('2m');
    expect(relativeAge(new Date(NOW - 3 * 3600_000), NOW)).toBe('3h');
    expect(relativeAge(new Date(NOW - 3 * 86400_000), NOW)).toBe('3d');
  });

  it('does not produce a negative age for a clock skew', () => {
    expect(relativeAge(new Date(NOW + 60_000), NOW)).toBe('now');
  });
});

describe('topicName', () => {
  it('leads with the status icon, then workspace, title and agent', () => {
    expect(topicName(session())).toBe('🟠 app / fix the sort order · claude');
  });

  it('stays inside the Telegram topic name limit', () => {
    const long = session({ title: 'x'.repeat(400), projectName: 'y'.repeat(60) });
    expect(topicName(long).length).toBeLessThanOrEqual(MAX_TOPIC_NAME_CHARS);
  });

  it('keeps the workspace and truncates the title, so sessions stay distinguishable', () => {
    const name = topicName(session({ title: 'z'.repeat(200) }));
    expect(name).toContain('app');
    expect(name).toContain('claude');
  });

  it('survives a workspace name that alone fills the limit', () => {
    const name = topicName(session({ projectName: 'w'.repeat(200) }));
    expect(name.length).toBeLessThanOrEqual(MAX_TOPIC_NAME_CHARS);
  });
});

describe('renderFleetList', () => {
  it('says so plainly when there is nothing to show', () => {
    expect(renderFleetList([], 'desktop', NOW)).toContain('No active sessions.');
  });

  it('says which list holds the rest when it is empty', () => {
    expect(renderFleetList([], 'desktop', NOW)).toContain('/history');
  });

  it('counts by what each session asks of you, not by state name', () => {
    // `approval` and `finished` both want something from you; `working` does not; `dormant` is
    // neither. The number worth reading at the top is "how many need me".
    const body = renderFleetList([
      { session: session({ sessionId: 'a', status: 'approval' }), owner: owned },
      { session: session({ sessionId: 'b', status: 'finished' }), owner: owned },
      { session: session({ sessionId: 'c', status: 'working' }), owner: owned },
      { session: session({ sessionId: 'd', status: 'dormant' }), owner: owned },
    ], 'desktop', NOW);
    expect(body).toContain('2 need you · 1 working · 4 active');
  });

  it('names a peer machine in the row, after the agent, not as a heading', () => {
    // The host used to group the list, which put the machine name above the workspace. The machine
    // is the last thing you need when you are looking for a piece of work.
    const body = renderFleetList([
      { session: session({ sessionId: 'a', peer: 'me@laptop2' }), owner: unowned },
    ], 'desktop', NOW);
    expect(body).toContain('app / fix the sort order · claude@me@laptop2');
    expect(body).not.toContain('(this machine)');
  });

  it('does not name this machine on every row', () => {
    const body = renderFleetList([{ session: session(), owner: owned }], 'desktop', NOW);
    expect(body.split('\n').filter(l => l.includes('desktop'))).toHaveLength(1);
  });

  it('orders rows by workspace and title, not by time', () => {
    // This message is edited in place, so a time ordering would reshuffle on every poll and be
    // unreadable. Rows must only move when a session appears or disappears.
    const body = renderFleetList([
      { session: session({ sessionId: 'a', projectName: 'zeta', updatedAt: new Date(NOW) }), owner: owned },
      { session: session({ sessionId: 'b', projectName: 'alpha', updatedAt: new Date(0) }), owner: owned },
    ], 'desktop', NOW);
    expect(body.indexOf('alpha')).toBeLessThan(body.indexOf('zeta'));
  });

  it('marks an unowned session read-only', () => {
    const body = renderFleetList([{ session: session(), owner: unowned }], 'desktop', NOW);
    expect(body).toContain('read-only');
  });

  it('does not mark an owned session read-only', () => {
    const body = renderFleetList([{ session: session(), owner: owned }], 'desktop', NOW);
    expect(body).not.toContain('read-only');
  });

  it('stays inside the Telegram message limit with many sessions', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      session: session({ sessionId: `s${i}`, title: `a rather long session title ${i}` }),
      owner: owned,
    }));
    expect(renderFleetList(many, 'desktop', NOW).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('fleetSignature', () => {
  it('ignores the passage of time, which every row shows and nothing can stop', () => {
    // The pinned list is edited in place and Telegram rate-limits edits. If a ticking age counted
    // as a change, the message would be re-edited every few seconds carrying no new information.
    const a = [{ session: session({ updatedAt: new Date(NOW - 1_000) }), owner: owned }];
    const b = [{ session: session({ updatedAt: new Date(NOW - 9 * 3600_000) }), owner: owned }];
    expect(fleetSignature(a)).toBe(fleetSignature(b));
  });

  it('changes when a session changes state', () => {
    const before = [{ session: session({ status: 'working' }), owner: owned }];
    const after = [{ session: session({ status: 'approval' }), owner: owned }];
    expect(fleetSignature(before)).not.toBe(fleetSignature(after));
  });

  it('changes when a session appears or disappears', () => {
    const one = [{ session: session({ sessionId: 'a' }), owner: owned }];
    const two = [...one, { session: session({ sessionId: 'b' }), owner: owned }];
    expect(fleetSignature(one)).not.toBe(fleetSignature(two));
  });

  it('changes when a session becomes writable', () => {
    // read-only is on the row, so gaining an owner has to redraw it.
    const before = [{ session: session(), owner: unowned }];
    const after = [{ session: session(), owner: owned }];
    expect(fleetSignature(before)).not.toBe(fleetSignature(after));
  });

  it('treats a reordering as no change', () => {
    const a = { session: session({ sessionId: 'a' }), owner: owned };
    const b = { session: session({ sessionId: 'b' }), owner: owned };
    expect(fleetSignature([a, b])).toBe(fleetSignature([b, a]));
  });

  it('is empty for an empty fleet', () => {
    expect(fleetSignature([])).toBe('');
  });
});

describe('renderHistoryList', () => {
  it('says plainly when the worklist already holds everything', () => {
    expect(renderHistoryList([], NOW)).toContain('already in the active list');
  });

  it('keeps the order it is given, so it can be newest first', () => {
    const body = renderHistoryList([
      { session: session({ sessionId: 'a', projectName: 'zeta' }), owner: owned },
      { session: session({ sessionId: 'b', projectName: 'alpha' }), owner: owned },
    ], NOW);
    expect(body.indexOf('zeta')).toBeLessThan(body.indexOf('alpha'));
  });

  it('says what tapping a row does', () => {
    const body = renderHistoryList([{ session: session(), owner: owned }], NOW);
    expect(body).toContain('active list');
  });

  it('stays inside the Telegram message limit', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      session: session({ sessionId: `s${i}`, title: `a rather long session title ${i}` }),
      owner: owned,
    }));
    expect(renderHistoryList(many, NOW).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('truncate2', () => {
  it('leaves a short body untouched, newlines included', () => {
    expect(truncate2('a\nb')).toBe('a\nb');
  });

  it('caps an oversized body and says it was cut', () => {
    const out = truncate2('x'.repeat(MAX_MESSAGE_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(out).toContain('truncated');
  });
});

describe('renderTopicHeader', () => {
  it('reads workspace, title, agent, host — the same order as everywhere else', () => {
    const body = renderTopicHeader(session(), owned, null);
    expect(body.indexOf('app')).toBeLessThan(body.indexOf('fix the sort order'));
    expect(body.indexOf('fix the sort order')).toBeLessThan(body.indexOf('agent: claude'));
    expect(body.indexOf('agent: claude')).toBeLessThan(body.indexOf('host:'));
  });

  it('tells the user they can type when the session is writable', () => {
    const body = renderTopicHeader(session(), owned, null);
    expect(body).toContain('Type here');
    expect(body).toContain('/work/app');
    expect(body).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('leads with the reason when it is not writable', () => {
    const body = renderTopicHeader(session({ source: 'codex' }), unowned, 'Codex is read-only.');
    expect(body).toContain('⚠ Codex is read-only.');
    expect(body).not.toContain('Type here');
  });

  it('names the owning window and how it claimed the session', () => {
    expect(renderTopicHeader(session(), owned, null)).toContain('pid 100');
    expect(renderTopicHeader(session(), { pid: 5, basis: 'workspace', workspace: '/w' }, null))
      .toContain('owns the workspace');
  });
});

describe('planMirror', () => {
  const turn = (text: string): MessageExchange => ({ role: 'user', text });
  it('posts nothing when there is nothing new', () => {
    const plan = planMirror([turn('a')], 1);
    expect(plan.messages).toEqual([]);
    expect(plan.nextCursor.count).toBe(1);
  });

  it('posts each new turn', () => {
    const plan = planMirror([turn('a'), turn('b')], 0);
    expect(plan.messages).toHaveLength(2);
    expect(plan.nextCursor.count).toBe(2);
  });

  it('posts every spoken turn of an ordinary pass', () => {
    // The conversation is the thing a reader is there for, and one with holes in it cannot be
    // replied to. Only a burst past the budget collapses.
    const turns = Array.from({ length: MAX_TURNS_PER_PASS_DEFAULT }, (_, i) => turn(`t${i}`));
    expect(planMirror(turns, 0).messages).toHaveLength(MAX_TURNS_PER_PASS_DEFAULT);
  });

  it('collapses a burst rather than flooding the group', () => {
    // Telegram tolerates roughly 20 messages a minute to one group. Posting a whole burst would
    // put every other topic minutes behind, so the overflow becomes one line.
    const turns = Array.from({ length: 30 }, (_, i) => turn(`t${i}`));
    const plan = planMirror(turns, 0);
    expect(plan.messages).toHaveLength(MAX_TURNS_PER_PASS_DEFAULT + 1);
    expect(plan.messages[0]).toContain(`${30 - MAX_TURNS_PER_PASS_DEFAULT} earlier turns not shown`);
    expect(plan.nextCursor.count).toBe(30);
  });

  it('takes the per-pass budget from the caller', () => {
    const turns = Array.from({ length: 6 }, (_, i) => turn(`t${i}`));
    expect(planMirror(turns, 0, { maxTurns: 2 }).messages).toHaveLength(3);
  });

  it('keeps the most recent turns when it collapses', () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(`t${i}`));
    const plan = planMirror(turns, 0);
    expect(plan.messages[plan.messages.length - 1]).toContain('t39');
  });

  it('advances past skipped turns so they are never replayed', () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(`t${i}`));
    const first = planMirror(turns, 0);
    expect(planMirror(turns, first.nextCursor).messages).toEqual([]);
  });

  it('recovers when the transcript is shorter than the cursor', () => {
    // A truncated or replaced transcript must not produce a negative slice.
    const plan = planMirror([turn('a')], 5);
    expect(plan.messages).toEqual([]);
    expect(plan.nextCursor.count).toBe(5);
  });

  it('uses the singular for exactly one skipped turn', () => {
    const turns = Array.from(
      { length: MAX_TURNS_PER_PASS_DEFAULT + 1 }, (_, i) => turn(`t${i}`));
    expect(planMirror(turns, 0).messages[0]).toContain('1 earlier turn not shown');
  });

  it('marks who said each turn', () => {
    const plan = planMirror([{ role: 'assistant', text: 'done' }], 0);
    expect(plan.messages[0]).toContain('🤖');
  });
});

describe('planMirror resumes from the last turn it posted', () => {
  const stamped = (text: string, seconds: number): MessageExchange => ({
    role: 'assistant', text, timestamp: new Date(NOW + seconds * 1000).toISOString(),
  });

  it('keeps posting once the reader\'s window stops growing', () => {
    // The defect this cursor replaces. The transcript reader returns a sliding window of the last
    // few turns, so a count-based cursor caught up with `turns.length` and stayed there: every
    // later pass saw "nothing new" and the topic went silent for the rest of the session.
    const window = (from: number) =>
      Array.from({ length: 6 }, (_, i) => stamped(`t${from + i}`, from + i));

    let cursor = planMirror(window(0), 6).nextCursor;
    const posted: string[] = [];
    for (let pass = 1; pass <= 4; pass++) {
      const plan = planMirror(window(pass), cursor);
      posted.push(...plan.messages);
      cursor = plan.nextCursor;
    }
    expect(posted).toHaveLength(4);
    expect(posted[3]).toContain('t9');
  });

  it('recovers turns newer than an anchor that has fallen out of the window', () => {
    // A session that produces more turns between two passes than the window holds pushes the
    // anchor out of it. The anchor's timestamp still orders it against what is in the window.
    const first = planMirror([stamped('a', 1)], 0);
    const later = [stamped('c', 3), stamped('d', 4)];
    const plan = planMirror(later, first.nextCursor);
    expect(plan.messages).toHaveLength(2);
  });

  it('posts nothing rather than reposting when nothing can be compared', () => {
    // No timestamps and no anchor in the window: skipping a turn costs one line, guessing the
    // other way reposts a conversation.
    const first = planMirror([{ role: 'user', text: 'a' }], 0);
    const plan = planMirror([{ role: 'user', text: 'b' }], first.nextCursor);
    expect(plan.messages).toEqual([]);
  });

  it('leaves the anchor alone when the transcript reads back empty', () => {
    const cursor = { key: turnKey(stamped('a', 1)), count: 1 };
    expect(planMirror([], cursor).nextCursor).toEqual(cursor);
  });
});

describe('turnKey', () => {
  it('is the same for the same turn read twice', () => {
    const turn: MessageExchange = { role: 'user', text: 'hello', timestamp: 'ts' };
    expect(turnKey(turn)).toBe(turnKey({ ...turn }));
  });

  it('tells two turns with the same text apart by their timestamp', () => {
    expect(turnKey({ role: 'user', text: 'again', timestamp: 't1' }))
      .not.toBe(turnKey({ role: 'user', text: 'again', timestamp: 't2' }));
  });

  it('tells a tool turn apart from a spoken one', () => {
    expect(turnKey({ role: 'assistant', text: 'x', kind: 'tool' }))
      .not.toBe(turnKey({ role: 'assistant', text: 'x' }));
  });

  it('ignores the whitespace a transcript reader may normalise', () => {
    expect(turnKey({ role: 'user', text: 'a  b' })).toBe(turnKey({ role: 'user', text: 'a b' }));
  });
});

describe('planMirror samples tool activity', () => {
  const tool = (text: string, seconds: number): MessageExchange => ({
    role: 'assistant', text, kind: 'tool',
    timestamp: new Date(NOW + seconds * 1000).toISOString(),
  });
  const sampling = { mirrorTools: true, toolSampleMs: 60_000, now: NOW, lastPostedAt: NOW - 90_000 };

  it('posts one line for a quiet topic', () => {
    const plan = planMirror([tool('Edit(src/a.ts)', 1)], 0, sampling);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toContain('🛠');
    expect(plan.messages[0]).toContain('Edit(src/a.ts)');
  });

  it('names how many calls it stands for', () => {
    const tools = [tool('Read(a)', 1), tool('Edit(b)', 2), tool('Bash(c)', 3)];
    expect(planMirror(tools, 0, sampling).messages[0])
      .toBe('🛠 Bash(c) · +2 more tool calls');
  });

  it('says nothing while the topic is still inside the quiet window', () => {
    const plan = planMirror([tool('Edit(a)', 1)], 0, { ...sampling, lastPostedAt: NOW - 1_000 });
    expect(plan.messages).toEqual([]);
  });

  it('advances the cursor past a sample it withheld, so it is never posted late', () => {
    const tools = [tool('Edit(a)', 1)];
    const plan = planMirror(tools, 0, { ...sampling, lastPostedAt: NOW });
    expect(plan.messages).toEqual([]);
    expect(planMirror(tools, plan.nextCursor, sampling).messages).toEqual([]);
  });

  it('gives the pass to the spoken turn when there is one', () => {
    // A turn already says the session is alive, which is the only thing a sample is for.
    const plan = planMirror(
      [tool('Edit(a)', 1), { role: 'assistant', text: 'done', timestamp: 'z' }], 0, sampling);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toContain('done');
  });

  it('does not count a tool turn against the spoken budget', () => {
    const turns: MessageExchange[] = [
      ...Array.from({ length: 30 }, (_, i) => tool(`Edit(${i})`, i)),
      { role: 'assistant', text: 'done', timestamp: 'z' },
    ];
    const plan = planMirror(turns, 0, sampling);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).not.toContain('not shown');
  });

  it('ignores tool turns altogether when sampling is off', () => {
    expect(planMirror([tool('Edit(a)', 1)], 0, { ...sampling, mirrorTools: false }).messages)
      .toEqual([]);
  });
});

describe('renderToolSample', () => {
  it('reads as activity rather than as an answer', () => {
    const line = renderToolSample([{ role: 'assistant', text: 'Bash(make check)', kind: 'tool' }]);
    expect(line).toEqual(['🛠 Bash(make check)']);
  });
});

describe('isEchoOfSent', () => {
  it('recognises a prompt this window just injected', () => {
    expect(isEchoOfSent('run the tests', ['run the tests'])).toBe(true);
  });

  it('ignores whitespace differences the transcript introduces', () => {
    expect(isEchoOfSent('run   the\ntests', ['run the tests'])).toBe(true);
  });

  it('does not match a different message', () => {
    expect(isEchoOfSent('run the tests', ['stop'])).toBe(false);
  });

  it('never matches on empty text', () => {
    expect(isEchoOfSent('   ', ['run the tests'])).toBe(false);
  });
});

describe('renderHelp and renderWho', () => {
  it('help states the write limits honestly', () => {
    const help = renderHelp();
    expect(help).toContain('Codex and Chat expose no message API');
    expect(help).toContain('/sessions');
  });

  it('help names /history and says what the list holds', () => {
    const help = renderHelp();
    expect(help).toContain('/history');
    expect(help).toContain('active sessions only');
  });

  it('who explains an unowned session instead of leaving it unexplained', () => {
    const body = renderWho([{ session: session(), owner: unowned }], 'desktop');
    expect(body).toContain('nobody — read-only');
  });

  it('who names the owning pid', () => {
    expect(renderWho([{ session: session(), owner: owned }], 'desktop')).toContain('pid 100');
  });

  it('who says so when there is nothing to show', () => {
    expect(renderWho([], 'desktop')).toBe('No sessions found.');
  });
});

describe('splitMessages', () => {
  const lead = '🤖 ';

  it('leaves a short body as one unnumbered message', () => {
    // Numbering a single message would be noise on the overwhelming majority of turns.
    expect(splitMessages(lead, 'done', 4)).toEqual(['🤖 done']);
  });

  it('keeps a body that exactly fills a message in one part', () => {
    const body = 'x'.repeat(MAX_MESSAGE_CHARS - lead.length);
    const parts = splitMessages(lead, body, 4);
    expect(parts).toHaveLength(1);
    expect(parts[0].length).toBe(MAX_MESSAGE_CHARS);
  });

  it('splits one character past the limit into two numbered parts', () => {
    const body = 'x'.repeat(MAX_MESSAGE_CHARS - lead.length + 1);
    const parts = splitMessages(lead, body, 4);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('(1/2)');
    expect(parts[1]).toContain('(2/2)');
  });

  it('never exceeds Telegram’s limit in any part', () => {
    const body = 'word '.repeat(6000);
    for (const part of splitMessages(lead, body, MAX_MESSAGE_PARTS_LIMIT)) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });

  it('loses not one character of the body when it fits the budget', () => {
    // The whole point of the feature: a split must be lossless, not a prettier truncation.
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the answer`).join('\n');
    const parts = splitMessages(lead, body, 4);
    expect(parts.length).toBeGreaterThan(1);
    const rejoined = parts
      .map(p => p.replace(/^🤖 \(\d+\/\d+\) /u, ''))
      .join('\n');
    expect(rejoined).toBe(body);
  });

  it('prefers a paragraph boundary over cutting mid-sentence', () => {
    const para = 'p'.repeat(3000);
    const parts = splitMessages(lead, `${para}\n\n${para}`, 4);
    expect(parts).toHaveLength(2);
    expect(parts[0].endsWith('p')).toBe(true);
    expect(parts[1].endsWith('p')).toBe(true);
  });

  it('falls back to a word boundary when there is no newline', () => {
    const body = 'word '.repeat(1200).trim();
    const parts = splitMessages(lead, body, 4);
    expect(parts[0].endsWith('word')).toBe(true);
  });

  it('hard-cuts a body with no boundary at all rather than overflowing', () => {
    const parts = splitMessages(lead, 'x'.repeat(9000), 4);
    expect(parts).toHaveLength(3);
    expect(parts.every(p => p.length <= MAX_MESSAGE_CHARS)).toBe(true);
  });

  it('points at the transcript when the body outruns the budget', () => {
    const parts = splitMessages(lead, 'x'.repeat(40_000), 2);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain('more characters');
    expect(parts[1]).toContain('Full transcript');
  });

  it('reports how much was left out, not a vague ellipsis', () => {
    const parts = splitMessages(lead, 'x'.repeat(20_000), 1);
    const shown = parts[0].replace(/\n… [\s\S]*$/, '').length - lead.length;
    expect(parts[0]).toContain(`${20_000 - shown} more characters`);
  });

  it('treats a maxParts of zero or less as one part', () => {
    // A setting clamped elsewhere must still not produce an empty mirror here.
    expect(splitMessages(lead, 'hello', 0)).toEqual(['🤖 hello']);
    expect(splitMessages(lead, 'hello', -3)).toEqual(['🤖 hello']);
  });

  it('never emits an empty message', () => {
    const parts = splitMessages(lead, 'x'.repeat(12_000), 4);
    expect(parts.every(p => p.trim().length > lead.trim().length)).toBe(true);
  });
});

describe('renderTurn', () => {
  it('marks who is speaking on every part, so a continuation is still attributed', () => {
    const parts = renderTurn({ role: 'assistant', text: 'x'.repeat(9000) }, 4);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.startsWith('🤖 '))).toBe(true);
  });

  it('keeps a single-part turn exactly as it was before splitting existed', () => {
    expect(renderTurn({ role: 'user', text: 'run the tests' }, 4))
      .toEqual(['🧑 run the tests']);
  });

  it('defaults to one part, so a caller that opts out is unaffected', () => {
    const parts = renderTurn({ role: 'assistant', text: 'x'.repeat(9000) });
    expect(parts).toHaveLength(1);
  });
});

describe('planMirror parts budget', () => {
  const turn = (text: string, role: 'user' | 'assistant' = 'assistant'): MessageExchange =>
    ({ role, text });

  it('splits a long answer instead of truncating it', () => {
    const plan = planMirror([turn('x'.repeat(12_000))], 0, { maxParts: 4 });
    expect(plan.messages).toHaveLength(3);
    expect(plan.messages.join('')).not.toContain('truncated');
  });

  it('gives the newest turn the whole budget and the older ones one part each', () => {
    // Telegram takes ~20 messages a minute for one group. When several turns land together the
    // last is the one being answered, so it gets the room and the rest stay one message apiece.
    const turns = [
      turn('x'.repeat(12_000)), turn('y'.repeat(12_000)), turn('z'.repeat(12_000)),
    ];
    const plan = planMirror(turns, 0, { maxParts: 4 });
    expect(plan.messages).toHaveLength(1 + 1 + 3);
    expect(plan.messages[0]).toContain('more characters');
    expect(plan.messages[plan.messages.length - 1]).toContain('(3/3)');
  });

  it('holds the worst case to the budget it was given', () => {
    const turns = Array.from({ length: 30 }, () => turn('x'.repeat(200_000)));
    const plan = planMirror(turns, 0, { maxParts: MAX_MESSAGE_PARTS_LIMIT, maxTurns: 4 });
    // one collapse line + (maxTurns - 1) single parts + the newest turn's full budget.
    expect(plan.messages.length).toBe(1 + 3 + MAX_MESSAGE_PARTS_LIMIT);
  });

  it('advances the cursor by turns, not by messages', () => {
    // The cursor counts transcript turns. Counting messages would replay a split turn forever.
    const turns = [turn('a'), turn('x'.repeat(12_000))];
    const plan = planMirror(turns, 0, { maxParts: 4 });
    expect(plan.nextCursor.count).toBe(2);
    expect(planMirror(turns, plan.nextCursor, { maxParts: 4 }).messages).toEqual([]);
  });

  it('keeps the old one-message-per-turn shape when no budget is given', () => {
    const plan = planMirror([turn('x'.repeat(12_000))], 0);
    expect(plan.messages).toHaveLength(1);
  });

  it('has a default budget of more than one part', () => {
    // The setting defaults on; a default of 1 would ship the feature switched off.
    expect(MAX_MESSAGE_PARTS_DEFAULT).toBeGreaterThan(1);
    expect(MAX_MESSAGE_PARTS_DEFAULT).toBeLessThanOrEqual(MAX_MESSAGE_PARTS_LIMIT);
  });
});

describe('planMirror echo suppression', () => {
  const sent = 'please run the full test suite';

  it('does not repost a prompt this window just injected', () => {
    const plan = planMirror([{ role: 'user', text: sent }], 0, { recentlySent: [sent] });
    expect(plan.messages).toEqual([]);
    expect(plan.nextCursor.count).toBe(1);
  });

  it('suppresses a prompt long enough to have been split', () => {
    // Telegram accepts 4096 characters, and the icon pushes that over one message — so the echo
    // check has to compare the turn, not the rendered message, or a long prompt comes straight back.
    const long = 'q'.repeat(MAX_MESSAGE_CHARS);
    const plan = planMirror([{ role: 'user', text: long }], 0, {
      recentlySent: [long], maxParts: 4,
    });
    expect(plan.messages).toEqual([]);
  });

  it('still posts the answer that follows a suppressed prompt', () => {
    const plan = planMirror(
      [{ role: 'user', text: sent }, { role: 'assistant', text: 'all green' }],
      0,
      { recentlySent: [sent] },
    );
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toContain('all green');
    expect(plan.nextCursor.count).toBe(2);
  });

  it('never suppresses an assistant turn, whatever was sent', () => {
    const plan = planMirror([{ role: 'assistant', text: sent }], 0, { recentlySent: [sent] });
    expect(plan.messages).toHaveLength(1);
  });

  it('posts a prompt typed at the keyboard rather than sent from Telegram', () => {
    const plan = planMirror([{ role: 'user', text: 'something else' }], 0,
      { recentlySent: [sent] });
    expect(plan.messages).toHaveLength(1);
  });
});
