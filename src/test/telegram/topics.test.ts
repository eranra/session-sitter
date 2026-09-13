import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANUAL_OPEN_GRACE_MS, STATUS_HOLD_MS_DEFAULT, TopicStore, parseTopic, shouldRenameTopic,
  topicsToDelete, type TopicRecord,
} from '../../telegram/topics';
import { topicsDir } from '../../telegram/bus';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-topics-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(over: Partial<TopicRecord> = {}): TopicRecord {
  return {
    threadId: 7,
    sessionId: 's1',
    source: 'claude',
    name: '🟠 app / a title · claude',
    nameSetAt: 500,
    mirroredTurns: 3,
    lastPostedAt: 500,
    closed: false,
    openedAt: 500,
    createdAt: 500,
    ...over,
  };
}

describe('parseTopic', () => {
  it('round-trips a record', () => {
    expect(parseTopic(JSON.stringify(record()))).toEqual(record());
  });

  it('reads a record written before openedAt existed, using its creation time', () => {
    // An installed extension already has topic files on disk from the previous version. Treating a
    // missing openedAt as 0 would strip the grace window from every one of them.
    const legacy: Record<string, unknown> = { ...record({ createdAt: 1234 }) };
    delete legacy.openedAt;
    expect(parseTopic(JSON.stringify(legacy))?.openedAt).toBe(1234);
  });

  it('rejects a record with no thread or session', () => {
    expect(parseTopic(JSON.stringify({ sessionId: 's1' }))).toBeNull();
    expect(parseTopic(JSON.stringify({ threadId: 7 }))).toBeNull();
  });

  it('rejects an unknown source', () => {
    expect(parseTopic(JSON.stringify({ ...record(), source: 'gemini' }))).toBeNull();
  });

  it('defaults a missing cursor to zero rather than to undefined', () => {
    const rest: Record<string, unknown> = { ...record() };
    delete rest.mirroredTurns;
    expect(parseTopic(JSON.stringify(rest))?.mirroredTurns).toBe(0);
  });

  it('rejects junk', () => {
    expect(parseTopic('nope')).toBeNull();
  });
});

describe('TopicStore', () => {
  it('saves and reads a record back by thread and by session', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    expect(await store.byThread(7)).toEqual(record());
    expect(await store.bySession('s1')).toEqual(record());
  });

  it('returns null for a thread or session it does not know', async () => {
    const store = new TopicStore(home);
    expect(await store.byThread(99)).toBeNull();
    expect(await store.bySession('nope')).toBeNull();
  });

  it('returns an empty list before anything is written', async () => {
    expect(await new TopicStore(home).all()).toEqual([]);
  });

  it('gives each thread its own file, so two windows never contend', async () => {
    // A single shared topics.json would be a lost-update race between windows, with no lock to
    // arbitrate it.
    const store = new TopicStore(home);
    await store.save(record({ threadId: 7, sessionId: 'a' }));
    await store.save(record({ threadId: 8, sessionId: 'b' }));
    expect(fs.readdirSync(topicsDir(home)).sort()).toEqual(['7.json', '8.json']);
    expect(await store.all()).toHaveLength(2);
  });

  it('overwrites a record in place when it is updated', async () => {
    const store = new TopicStore(home);
    await store.save(record({ mirroredTurns: 3 }));
    await store.save(record({ mirroredTurns: 9 }));
    expect((await store.byThread(7))?.mirroredTurns).toBe(9);
    expect(await store.all()).toHaveLength(1);
  });

  it('removes a record and tolerates a repeat', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    await store.remove(7);
    expect(await store.byThread(7)).toBeNull();
    await expect(store.remove(7)).resolves.toBeUndefined();
  });

  it('skips a malformed file instead of failing the whole read', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    fs.writeFileSync(path.join(topicsDir(home), '9.json'), 'not json');
    expect(await store.all()).toHaveLength(1);
  });

  it('sees a record another window wrote, holding no stale cache', async () => {
    const a = new TopicStore(home);
    const b = new TopicStore(home);
    expect(await b.all()).toEqual([]);
    await a.save(record());
    expect(await b.byThread(7)).not.toBeNull();
  });
});

describe('topicsToDelete', () => {
  // Well past MANUAL_OPEN_GRACE_MS, so the grace window is out of the way unless a test wants it.
  const LATER = 500 + MANUAL_OPEN_GRACE_MS * 10;

  it('deletes the topic of a session that has left the active list', () => {
    // The group's topic list has to equal the panel's session list. Closing was not enough:
    // Telegram keeps a closed topic in the list, so every session that ever ran stayed visible.
    const gone = record({ threadId: 7, sessionId: 'gone' });
    expect(topicsToDelete([gone], new Set(['still-here']), LATER)).toEqual([gone]);
  });

  it('leaves the topic of an active session alone', () => {
    const live = record({ threadId: 7, sessionId: 'live' });
    expect(topicsToDelete([live], new Set(['live']), LATER)).toEqual([]);
  });

  it('deletes an already-closed topic too', () => {
    // The version that only closed topics left a pile of closed records behind. Skipping them here
    // would leave every one of those threads in the group forever.
    const closed = record({ sessionId: 'gone', closed: true });
    expect(topicsToDelete([closed], new Set<string>(), LATER)).toEqual([closed]);
  });

  it('spares a topic you just opened by hand', () => {
    // `/history` opens the topic of a session that is by definition not active. Deleting it on the
    // next pass would make the button look broken.
    const justOpened = record({ sessionId: 'gone', openedAt: 1_000 });
    expect(topicsToDelete([justOpened], new Set<string>(), 1_000 + 60_000)).toEqual([]);
  });

  it('deletes it once the grace window has passed', () => {
    const opened = record({ sessionId: 'gone', openedAt: 1_000 });
    expect(topicsToDelete([opened], new Set<string>(), 1_000 + MANUAL_OPEN_GRACE_MS + 1))
      .toEqual([opened]);
  });

  it('does not treat an unknown open time as freshly opened', () => {
    // 0 means "not recorded", so it must not buy an old topic an indefinite reprieve.
    const legacy = record({ sessionId: 'gone', openedAt: 0 });
    expect(topicsToDelete([legacy], new Set<string>(), 60_000)).toEqual([legacy]);
  });

  it('would delete everything for an empty active set — which is why the caller guards it', () => {
    // Documented deliberately: this function cannot tell "nothing is active" from "the session
    // list has not loaded yet". `pruneInactiveTopics` makes that distinction before calling.
    const a = record({ threadId: 1, sessionId: 'a' });
    const b = record({ threadId: 2, sessionId: 'b' });
    expect(topicsToDelete([a, b], new Set<string>(), LATER)).toEqual([a, b]);
  });
});

// ── A record that cannot be read must not hide a topic ────────────────────────
//
// `all()` skips a file it cannot parse, and for every other caller that is right — a half-written
// record is not a session mapping. For pruning it is exactly wrong: the topic is real, it is in the
// group, and skipping its record makes it unreachable. A bot cannot list a group's topics
// (`getForumTopics` is a user-API method: "Only users can use this method"), so a topic the store
// has forgotten can never be found again by any means. The filename is the thread id, which is
// enough to delete it, so a damaged record leaves the group tidy instead of leaving a thread behind
// for good.
describe('TopicStore: damaged records', () => {
  it('reports the thread id of a file it cannot parse', async () => {
    const store = new TopicStore(home);
    await store.save(record({ threadId: 11, sessionId: 'live' }));
    fs.mkdirSync(topicsDir(home), { recursive: true });
    fs.writeFileSync(path.join(topicsDir(home), '22.json'), '{ truncated', 'utf8');

    expect((await store.all()).map(t => t.threadId)).toEqual([11]);
    expect(await store.damagedThreadIds()).toEqual([22]);
  });

  it('ignores files whose name is not a thread id', async () => {
    const store = new TopicStore(home);
    fs.mkdirSync(topicsDir(home), { recursive: true });
    fs.writeFileSync(path.join(topicsDir(home), 'notes.json'), 'whatever', 'utf8');
    expect(await store.damagedThreadIds()).toEqual([]);
  });

  it('does not report a record that parses', async () => {
    const store = new TopicStore(home);
    await store.save(record({ threadId: 33 }));
    expect(await store.damagedThreadIds()).toEqual([]);
  });
});

// A status is derived from a transcript, and an agent between tool calls leaves `working` and comes
// back to it seconds later. Every one of those wrote a rename, so one busy session filled the group
// with "Name changed" notices and drowned out the sessions that actually needed somebody.
describe('shouldRenameTopic', () => {
  const named = (over: Partial<TopicRecord> = {}) =>
    record({ name: '🔄 app / a title · claude', nameSetAt: 1_000_000, ...over });
  const WORKING = named().name;
  const SEEN = '⚫ app / a title · claude';

  it('does nothing when the name already says what it should', () => {
    expect(shouldRenameTopic(named(), WORKING, 'working', 1_000_000, STATUS_HOLD_MS_DEFAULT))
      .toBe(false);
  });

  it('holds a change that lands inside the window', () => {
    expect(shouldRenameTopic(named(), SEEN, 'seen', 1_030_000, STATUS_HOLD_MS_DEFAULT)).toBe(false);
  });

  it('writes the change once the window is up', () => {
    expect(shouldRenameTopic(named(), SEEN, 'seen', 1_060_000, STATUS_HOLD_MS_DEFAULT)).toBe(true);
  });

  it('never renames at all when the status flaps back inside the window', () => {
    // working → seen → working. The first is held; by the time the hold is up the wanted name is
    // the one already on the topic, so nothing is ever written. This is the point of the setting.
    expect(shouldRenameTopic(named(), SEEN, 'seen', 1_020_000, STATUS_HOLD_MS_DEFAULT)).toBe(false);
    expect(shouldRenameTopic(named(), WORKING, 'working', 1_090_000, STATUS_HOLD_MS_DEFAULT))
      .toBe(false);
  });

  it('never holds a status that needs you', () => {
    // The topic list is worth reading because of these two. Showing an approval a minute late would
    // trade a real cost for a cosmetic one.
    for (const status of ['approval', 'question'] as const) {
      expect(shouldRenameTopic(named(), '🟠 x', status, 1_000_001, STATUS_HOLD_MS_DEFAULT), status)
        .toBe(true);
    }
  });

  it('never holds a fault', () => {
    expect(shouldRenameTopic(named(), '🔴 x', 'stalled', 1_000_001, STATUS_HOLD_MS_DEFAULT))
      .toBe(true);
  });

  it('writes every change when the hold is turned off', () => {
    expect(shouldRenameTopic(named(), SEEN, 'seen', 1_000_001, 0)).toBe(true);
  });

  it('writes the first change after an upgrade, rather than holding an unknown age', () => {
    // A record from a build before the hold existed has no `nameSetAt`, so it parses as 0.
    const upgraded = parseTopic(JSON.stringify({ ...named(), nameSetAt: undefined }));
    expect(upgraded?.nameSetAt).toBe(0);
    expect(shouldRenameTopic(upgraded!, SEEN, 'seen', 1_000_001, STATUS_HOLD_MS_DEFAULT))
      .toBe(true);
  });
});
