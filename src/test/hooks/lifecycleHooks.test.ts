import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import { handle as sessionStart, modelName, SessionRecord } from '../../hooks/sessionStart';
import { handle as postToolUse } from '../../hooks/postToolUse';
import { handle as sessionEnd } from '../../hooks/sessionEnd';
import { handle as notification } from '../../hooks/notification';
import { parseInput, readStdin } from '../../hooks/io';
import { activityPath, dataDir, decisionsPath, sessionPath, sessionsDir } from '../../hooks/paths';
import { haystackFor, sessionFromPermissionRequest } from '../../hooks/session';
import { appendJsonl } from '../../audit/trail';

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-life-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const readSession = (id: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(sessionPath(id), 'utf8'));

// --------------------------------------------------------------------------- paths

describe('paths', () => {
  it('prefers the plugin data dir Claude Code provides', () => {
    expect(dataDir({ CLAUDE_PLUGIN_DATA: '/data/plug' })).toBe('/data/plug');
  });

  it('falls back under ~/.claude when the plugin is loaded session-only', () => {
    expect(dataDir({})).toBe(path.join(os.homedir(), '.claude', 'session-sitter'));
  });

  it('keeps every file under the data dir', () => {
    for (const p of [decisionsPath(), activityPath(), sessionsDir(), sessionPath('abc')]) {
      expect(p.startsWith(dir)).toBe(true);
    }
  });

  it('never lets a session id escape the sessions dir', () => {
    expect(sessionPath('../../etc/passwd')).toBe(path.join(sessionsDir(), '------etc-passwd.json'));
    expect(sessionPath('')).toBe(path.join(sessionsDir(), 'unknown.json'));
  });
});

// --------------------------------------------------------------------------- io

describe('parseInput', () => {
  it('parses an event', () => {
    expect(parseInput('{"session_id":"s"}').session_id).toBe('s');
  });
  it('turns malformed JSON into an empty event rather than throwing', () => {
    expect(parseInput('not json')).toEqual({});
    expect(parseInput('')).toEqual({});
    expect(parseInput('[1,2]')).toEqual([1, 2]); // an array is an object; the hooks tolerate it
    expect(parseInput('null')).toEqual({});
  });
});

describe('readStdin', () => {
  it('reads a piped payload', async () => {
    const stream = new PassThrough();
    const done = readStdin(stream as unknown as NodeJS.ReadStream);
    stream.end('{"a":1}');
    expect(await done).toBe('{"a":1}');
  });

  it('resolves immediately on a tty rather than waiting for input', async () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    (stream as { isTTY?: boolean }).isTTY = true;
    expect(await readStdin(stream)).toBe('');
  });
});

// --------------------------------------------------------------------------- the session adapter

describe('the session adapter', () => {
  it('passes the Claude Code tool name straight through — tiers.ts names them itself', () => {
    const session = sessionFromPermissionRequest({
      session_id: 's', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(session.pendingAction).toMatchObject({
      kind: 'tool_call', name: 'Bash', arguments: { command: 'ls' },
    });
    expect(session.turns).toEqual([]); // deliberately not read — see session.ts
    expect(session.projectPath).toBe('/repo');
  });

  it('includes the tool name and its arguments in the haystack', () => {
    expect(haystackFor('Bash', { command: 'rm -rf /' })).toContain('rm -rf /');
    expect(haystackFor('Bash', null)).toBe('Bash ');
  });
});

// --------------------------------------------------------------------------- SessionStart

describe('SessionStart', () => {
  it('registers the session', async () => {
    await sessionStart({
      session_id: 'sess-a', cwd: '/repo', source: 'startup',
      session_title: 'nightly run', model: 'claude-opus-5',
    });
    const record = readSession('sess-a') as unknown as SessionRecord;
    expect(record).toMatchObject({
      sessionId: 'sess-a', cwd: '/repo', source: 'startup',
      name: 'nightly run', model: 'claude-opus-5',
    });
    expect(record.host).toBeTruthy();
    expect(record.pid).toBeGreaterThan(0);
    expect(record.startedAt).toMatch(/^\d{4}-/);
  });

  it('is idempotent, because it also runs on resume', async () => {
    await sessionStart({ session_id: 'sess-a', cwd: '/repo', source: 'startup' });
    await sessionStart({ session_id: 'sess-a', cwd: '/repo', source: 'resume' });
    expect(fs.readdirSync(sessionsDir())).toEqual(['sess-a.json']);
    expect(readSession('sess-a').source).toBe('resume');
  });

  it('adds no context, because this hook has none to add', async () => {
    expect(await sessionStart({ session_id: 'sess-a' })).toEqual({});
  });

  it('reads the model whichever shape it arrives in', () => {
    expect(modelName('claude-opus-5')).toBe('claude-opus-5');
    expect(modelName({ id: 'claude-opus-5', display_name: 'Opus 5' })).toBe('claude-opus-5');
    expect(modelName({ display_name: 'Opus 5' })).toBe('Opus 5');
    expect(modelName(undefined)).toBeNull();
    expect(modelName('')).toBeNull();
  });
});

// --------------------------------------------------------------------------- PostToolUse

describe('PostToolUse and PostToolUseFailure', () => {
  const activity = (): Record<string, unknown>[] =>
    fs.readFileSync(activityPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));

  it('records a success', async () => {
    await postToolUse({
      session_id: 'sess-a', hook_event_name: 'PostToolUse',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(activity()[0]).toMatchObject({ sessionId: 'sess-a', tool: 'Bash', ok: true });
  });

  it('records a failure', async () => {
    await postToolUse({
      session_id: 'sess-a', hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(activity()[0].ok).toBe(false);
  });

  it('stores a fingerprint, never the input', async () => {
    await postToolUse({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo hunter2' },
    });
    const line = fs.readFileSync(activityPath(), 'utf8');
    expect(line).not.toContain('hunter2');
    expect(String(activity()[0].fingerprint)).toHaveLength(12);
  });

  it('gives an identical repeated call an identical fingerprint', async () => {
    const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' } };
    await postToolUse(event);
    await postToolUse(event);
    const [a, b] = activity();
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('returns no decision fields — neither event can block', async () => {
    expect(await postToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).toEqual({});
  });
});

// --------------------------------------------------------------------------- Notification

describe('Notification', () => {
  it('records the waiting state', async () => {
    await notification({
      session_id: 'sess-a', notification_type: 'idle_prompt', message: 'Claude is waiting',
    });
    const line = JSON.parse(fs.readFileSync(activityPath(), 'utf8').trim());
    expect(line).toMatchObject({
      sessionId: 'sess-a', waiting: 'idle_prompt', message: 'Claude is waiting',
    });
  });

  it('bounds the message', async () => {
    await notification({ notification_type: 'permission_prompt', message: 'x'.repeat(500) });
    const line = JSON.parse(fs.readFileSync(activityPath(), 'utf8').trim());
    expect(String(line.message)).toHaveLength(200);
  });

  it('answers nothing — the event accepts no decision', async () => {
    expect(await notification({ notification_type: 'permission_prompt' })).toEqual({});
  });
});

// --------------------------------------------------------------------------- SessionEnd

describe('SessionEnd', () => {
  it('closes the registration out and counts the session\'s decisions', async () => {
    await sessionStart({ session_id: 'sess-a', cwd: '/repo', source: 'startup' });
    for (const rec of [
      { sessionId: 'sess-a', decision: 'deny', rewritten: false },
      { sessionId: 'sess-a', decision: 'allow', rewritten: true },
      { sessionId: 'sess-a', decision: 'allow', rewritten: false },
      { sessionId: 'other', decision: 'deny', rewritten: false },
    ]) { appendJsonl(decisionsPath(), rec); }

    await sessionEnd({ session_id: 'sess-a', reason: 'prompt_input_exit' });

    expect(readSession('sess-a')).toMatchObject({
      sessionId: 'sess-a',
      cwd: '/repo',                    // the registration is preserved, not replaced
      endReason: 'prompt_input_exit',
      decisions: 3,                    // only this session's
      denied: 1,
      corrected: 1,
    });
    expect(readSession('sess-a').endedAt).toMatch(/^\d{4}-/);
  });

  it('closes out a session that was never registered', async () => {
    await sessionEnd({ session_id: 'sess-ghost', reason: 'other' });
    expect(readSession('sess-ghost')).toMatchObject({
      sessionId: 'sess-ghost', endReason: 'other', decisions: 0,
    });
  });

  it('returns no decision fields — the event discards them anyway', async () => {
    expect(await sessionEnd({ session_id: 'sess-a' })).toEqual({});
  });

  it('writes the panel’s terminal marker to the activity trail', async () => {
    // The per-session file above is the audit record; the panel reads the activity trail. Without a
    // line there, a transcript that ends mid-tool-call stays `approval` for a full day — a dead
    // session at the top of the worklist with nothing able to clear it. See src/hookActivity.ts.
    await sessionEnd({ session_id: 'sess-end', reason: 'prompt_input_exit' });

    const lines = fs.readFileSync(activityPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const marker = lines.find(l => l.sessionId === 'sess-end');
    expect(marker).toMatchObject({ sessionId: 'sess-end', waiting: 'session_end' });
    expect(marker.ts).toMatch(/^\d{4}-/);
  });
});

// --------------------------------------------------------------------------- SessionEnd: Stage A

/**
 * Stage A of the learning pipeline rides on this hook. The middle test is the one that matters: the
 * fold is driven by a committed offset rather than by the event, so a `SessionEnd` that never fires
 * costs delay and never data.
 */
describe('SessionEnd folds the trail (Stage A)', () => {
  const decision = (command: string, over: Record<string, unknown> = {}): void => {
    appendJsonl(decisionsPath(), {
      ts: '2026-08-25T09:00:00.000Z',
      sessionId: 's-A', cwd: '/w/api', tool: 'Bash', inputSummary: command,
      light: 'green', decision: 'allow', clause: null, actor: 'model', latencyMs: 2000,
      rewritten: false, call: { tool_name: 'Bash', input: { command } },
      ...over,
    });
  };

  /** Three sessions across three calendar days — the cheapest support set that clears the user bar. */
  const crossTheFloor = (): void => {
    decision('pnpm test', { sessionId: 's-A', ts: '2026-08-25T09:00:00.000Z' });
    decision('pnpm test --watch', { sessionId: 's-B', ts: '2026-08-27T09:00:00.000Z' });
    decision('pnpm test --filter x', { sessionId: 's-C', ts: '2026-09-01T09:00:00.000Z' });
  };

  it('nudges once when a shape crosses the support floor, and never twice', async () => {
    crossTheFloor();
    const first = await sessionEnd({ session_id: 's-C', reason: 'clear' });
    expect(first.systemMessage).toContain('crossed the support floor');
    expect(first.systemMessage).toContain('session-sitter learn');
    // A second close with nothing new folds nothing, so it says nothing.
    expect(await sessionEnd({ session_id: 's-C', reason: 'clear' })).toEqual({});
  });

  it('says nothing when nothing crossed', async () => {
    decision('pnpm test');
    expect(await sessionEnd({ session_id: 's-A', reason: 'clear' })).toEqual({});
  });

  it('folds bytes from sessions whose own SessionEnd never fired', async () => {
    // ONE hook invocation, for the last session only. The other two crashed out.
    crossTheFloor();
    const out = await sessionEnd({ session_id: 's-C', reason: 'other' });
    const shapes = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline', 'shapes.json'), 'utf8'));
    expect(shapes.shapes['Bash|pnpm test'].records).toBe(3);
    expect([...shapes.shapes['Bash|pnpm test'].sessions].sort()).toEqual(['s-A', 's-B', 's-C']);
    expect(out.systemMessage).toBeDefined();
  });

  it('proposes nothing — no clause file, ever, from a hook', async () => {
    crossTheFloor();
    await sessionEnd({ session_id: 's-C', reason: 'clear' });
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline.jsonl'), 'utf8').trim());
    expect(run.stage).toBe('accumulate');
    expect(run.candidates.proposed).toBe(0);
    expect(run.model.calls).toBe(0);
  });

  it('still closes the session out when the fold cannot run', async () => {
    // `pipeline` is a file, not a directory, so every write beneath it fails.
    fs.writeFileSync(path.join(dir, 'pipeline'), 'not a directory', 'utf8');
    decision('pnpm test');
    expect(await sessionEnd({ session_id: 's-A', reason: 'clear' })).toEqual({});
    expect(readSession('s-A')).toMatchObject({ sessionId: 's-A', endReason: 'clear' });
  });
});
