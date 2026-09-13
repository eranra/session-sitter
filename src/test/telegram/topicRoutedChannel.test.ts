import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TopicRoutedChannel } from '../../telegram/topicRoutedChannel';
import { ForumApi } from '../../telegram/forum';
import { TopicStore, type TopicRecord } from '../../telegram/topics';
import type { ApiFn } from '../../supervisor/telegram';
import type { MessagingChannel, SendResult } from '../../supervisor/messaging';
import type { SupervisionRecord } from '../../supervisor/models';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-routed-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(sessionId = 's1'): SupervisionRecord {
  return { request_id: 'req-1', session_id: sessionId } as SupervisionRecord;
}

function topic(over: Partial<TopicRecord> = {}): TopicRecord {
  return {
    threadId: 7,
    sessionId: 's1',
    source: 'claude',
    name: 'a topic',
    nameSetAt: 0,
    mirroredTurns: 0,
    lastPostedAt: 0,
    closed: false,
    openedAt: 0,
    createdAt: 0,
    ...over,
  };
}

/** An inner channel that records what it was asked to send. */
function innerChannel() {
  const sent: Array<{ requestId: string; interactive: boolean }> = [];
  const channel: MessagingChannel = {
    send: async (rec, _notification, interactive = true): Promise<SendResult> => {
      sent.push({ requestId: rec.request_id, interactive });
      return { messageId: 'inner-1', sentAt: '2026-09-01T00:00:00Z' };
    },
    pollResponses: async () => [],
  };
  return { channel, sent };
}

function forum(replies: Record<string, Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api: ApiFn = async (method, payload) => {
    calls.push({ method, payload });
    return replies[method] ?? { ok: true, result: { message_id: 99 } };
  };
  return { forum: new ForumApi(api, '-100999'), calls };
}

const buildCard = () => ['a card', { inline_keyboard: [[{ text: 'ok', callback_data: 'req-1|0' }]] }] as
  [string, { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }];

describe('TopicRoutedChannel', () => {
  it('posts a card into the topic of the session it is about', async () => {
    const topics = new TopicStore(home);
    await topics.save(topic());
    const inner = innerChannel();
    const f = forum();
    const channel = new TopicRoutedChannel({
      inner: inner.channel, topics, forum: f.forum, buildCard,
    });

    const result = await channel.send(record(), 'notification');

    expect(result.messageId).toBe('99');
    expect(f.calls[0].payload.message_thread_id).toBe(7);
    expect(inner.sent).toEqual([]); // the inner channel was not used
  });

  it('keeps the card buttons, so the answer still routes back to supervision', async () => {
    const topics = new TopicStore(home);
    await topics.save(topic());
    const f = forum();
    await new TopicRoutedChannel({
      inner: innerChannel().channel, topics, forum: f.forum, buildCard,
    }).send(record(), 'notification');

    const markup = f.calls[0].payload.reply_markup as
      { inline_keyboard: Array<Array<{ callback_data: string }>> };
    // No `rc|` prefix means the update router hands the tap to supervision, which is what makes
    // answering a decision from inside a session topic work.
    expect(markup.inline_keyboard[0][0].callback_data).toBe('req-1|0');
  });

  it('falls back to the plain channel when the session has no topic yet', async () => {
    // Normal: a prompt can be raised before the owning window's next pass creates the topic. A
    // supervision card is a question an agent is blocked on, so it must never be dropped.
    const inner = innerChannel();
    const channel = new TopicRoutedChannel({
      inner: inner.channel, topics: new TopicStore(home), forum: forum().forum, buildCard,
    });

    const result = await channel.send(record('unknown'), 'notification');

    expect(result.messageId).toBe('inner-1');
    expect(inner.sent).toHaveLength(1);
  });

  it('falls back when Telegram rejects the topic post', async () => {
    const topics = new TopicStore(home);
    await topics.save(topic());
    const inner = innerChannel();
    const channel = new TopicRoutedChannel({
      inner: inner.channel,
      topics,
      forum: forum({ sendMessage: { ok: false, description: 'thread not found' } }).forum,
      buildCard,
    });

    const result = await channel.send(record(), 'notification');

    expect(result.messageId).toBe('inner-1');
    expect(inner.sent).toHaveLength(1);
  });

  it('falls back when the topic store cannot be read', async () => {
    const broken = {
      bySession: async () => { throw new Error('disk gone'); },
    } as unknown as TopicStore;
    const inner = innerChannel();
    const result = await new TopicRoutedChannel({
      inner: inner.channel, topics: broken, forum: forum().forum, buildCard,
    }).send(record(), 'notification');
    expect(result.messageId).toBe('inner-1');
  });

  it('passes the one-way flag through, so a green update is not made interactive', async () => {
    const inner = innerChannel();
    await new TopicRoutedChannel({
      inner: inner.channel, topics: new TopicStore(home), forum: forum().forum, buildCard,
    }).send(record('unknown'), 'notification', false);
    expect(inner.sent[0].interactive).toBe(false);
  });

  it('delegates polling, timers and setup unchanged', async () => {
    let polled = 0;
    let refreshed = 0;
    let readied = 0;
    const inner: MessagingChannel = {
      send: async () => ({ messageId: '1', sentAt: '' }),
      pollResponses: async () => { polled++; return []; },
      refreshTimers: async () => { refreshed++; },
      ensurePollingReady: async () => { readied++; },
    };
    const channel = new TopicRoutedChannel({
      inner, topics: new TopicStore(home), forum: forum().forum, buildCard,
    });
    await channel.pollResponses([]);
    await channel.refreshTimers([]);
    await channel.ensurePollingReady();
    expect([polled, refreshed, readied]).toEqual([1, 1, 1]);
  });

  it('tolerates an inner channel with no optional methods', async () => {
    const channel = new TopicRoutedChannel({
      inner: innerChannel().channel, topics: new TopicStore(home), forum: forum().forum, buildCard,
    });
    await expect(channel.refreshTimers([])).resolves.toBeUndefined();
    await expect(channel.ensurePollingReady()).resolves.toBeUndefined();
  });
});
