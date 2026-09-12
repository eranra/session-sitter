import { describe, it, expect } from 'vitest';
import { CliError } from '../../cli/args';
import type { ClaudeSession } from '../../sessionScan';
import { filterSessions, type Worklist } from '../../cli/sessions';
import type { Ownership } from '../../telegram/ownership';
import { SESSION_STATUSES } from '../../sessionStatus';
import { sortSessions } from '../../sessionSort';
import { renderJson, renderText, run, parseStatusArgs, type StatusOptions } from '../../cli/status';
import { fakeIo } from './fakeIo';

const NOW = new Date('2026-09-01T09:00:00.000Z');

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'aaa',
    projectName: 'session-sitter',
    projectPath: '/home/u/session-sitter',
    title: 'extract the pure readers',
    updatedAt: new Date(NOW.getTime() - 60_000),
    status: 'finished',
    source: 'claude',
    ...over,
  };
}

const OPTIONS: StatusOptions = {
  needsMe: false, sort: 'status', peers: false, owners: false, json: false,
};

describe('the six-state markers', () => {
  const io = fakeIo({ now: NOW });

  it('renders a distinct glyph and label for every state', () => {
    // No state may share a marker with another, and none may render blank: the glyph is the only
    // thing left once NO_COLOR strips the colour.
    const rendered = SESSION_STATUSES.map(status => {
      const rows = renderText([session({ status })], { sessions: [], peers: [] }, OPTIONS, io)
        .split('\n');
      const row = rows.find(l => /^\S/.test(l) && l.includes('Claude'));
      expect(row, status).toBeDefined();
      return row!.split(/\s\s+/).slice(0, 2).join(' ');
    });
    expect(new Set(rendered).size).toBe(SESSION_STATUSES.length);
    for (const marker of rendered) { expect(marker.trim()).not.toBe(''); }
  });

  it('names every state it renders with the state\'s own word', () => {
    for (const status of SESSION_STATUSES) {
      const out = renderText([session({ status })], { sessions: [], peers: [] }, OPTIONS, io);
      expect(out, status).toContain(status);
    }
  });

  it('the default order leads with the states that are blocked on you', () => {
    // sessionSort owns the ranking; this asserts the CLI actually asks for it.
    const rows = sortSessions([
      session({ sessionId: 'dormant', status: 'dormant' }),
      session({ sessionId: 'working', status: 'working' }),
      session({ sessionId: 'question', status: 'question' }),
      session({ sessionId: 'approval', status: 'approval' }),
      session({ sessionId: 'finished', status: 'finished' }),
      session({ sessionId: 'seen', status: 'seen' }),
    ], 'status');
    expect(rows.map(r => r.sessionId))
      .toEqual(['approval', 'question', 'finished', 'working', 'seen', 'dormant']);
  });
});

describe('filterSessions', () => {
  const sessions = [
    session({ sessionId: 'recent-claude' }),
    session({ sessionId: 'old-claude', updatedAt: new Date(NOW.getTime() - 3 * 86_400_000) }),
    session({ sessionId: 'chat', source: 'chat' }),
    session({ sessionId: 'busy', status: 'working' }),
    session({ sessionId: 'blocked', status: 'approval' }),
    session({ sessionId: 'asking', status: 'question' }),
  ];

  it('drops sessions older than the window', () => {
    expect(filterSessions(sessions, { since: new Date(NOW.getTime() - 86_400_000) })
      .map(s => s.sessionId)).toEqual(['recent-claude', 'chat', 'busy', 'blocked', 'asking']);
  });

  it('filters by agent', () => {
    expect(filterSessions(sessions, { agent: 'chat' }).map(s => s.sessionId)).toEqual(['chat']);
  });

  it('--needs-me keeps approval and question, and nothing else', () => {
    // Deliberately NOT 'finished': an unread result is worth a look, but nothing is stalled on you
    // looking at it, and a to-do list that includes everything you have not read is not a to-do list.
    expect(filterSessions(sessions, { needsMe: true }).map(s => s.sessionId))
      .toEqual(['blocked', 'asking']);
  });

  it('keeps everything with no filter', () => {
    expect(filterSessions(sessions, {})).toHaveLength(6);
  });
});

describe('parseStatusArgs', () => {
  const io = fakeIo({ now: NOW });

  it('defaults to a 24-hour window and the urgency order', () => {
    const options = parseStatusArgs([], io);
    // 'status' is sessionSort's urgency ranking: approval, question, finished, working, seen, dormant.
    expect(options.sort).toBe('status');
    expect(options.since).toEqual(new Date(NOW.getTime() - 86_400_000));
  });

  it('--all lifts the window', () => {
    expect(parseStatusArgs(['--all'], io).since).toBeUndefined();
  });

  it('rejects contradictions rather than silently preferring one', () => {
    expect(() => parseStatusArgs(['--all', '--since', '2h'], io)).toThrow(/contradict/);
    expect(() => parseStatusArgs(['--watch', '--json'], io)).toThrow(/cannot be combined/);
  });

  it('accepts every order sessionSort defines, and rejects anything else', () => {
    for (const mode of ['recent', 'workspace', 'hostWorkspace', 'status', 'source', 'title']) {
      expect(parseStatusArgs(['--sort', mode], io).sort).toBe(mode);
    }
    expect(() => parseStatusArgs(['--sort', 'sideways'], io)).toThrow(/unknown --sort/);
  });

  it('rejects an agent it cannot filter by', () => {
    expect(parseStatusArgs(['--agent', 'CLAUDE'], io).agent).toBe('claude');
    expect(() => parseStatusArgs(['--agent', 'gemini'], io)).toThrow(/unknown --agent/);
  });

  it('refuses --watch when stdout is not a terminal', () => {
    // Into a pipe the escapes are garbage and the frames append forever.
    expect(() => parseStatusArgs(['--watch'], io)).toThrow(/--watch needs a terminal/);
    const tty = fakeIo({ now: NOW, isTty: true });
    expect(parseStatusArgs(['--watch'], tty).watchSeconds).toBe(5);
    expect(parseStatusArgs(['--watch', '2'], tty).watchSeconds).toBe(2);
    expect(() => parseStatusArgs(['--watch', '0'], tty)).toThrow(/at least 1 second/);
  });

  it('rejects a positional argument', () => {
    expect(() => parseStatusArgs(['claude'], io)).toThrow(CliError);
  });
});

describe('renderText', () => {
  const sessions = [
    session({ sessionId: 'a', title: 'paused on a prompt', status: 'approval' }),
    session({ sessionId: 'b', title: 'running tools', status: 'working' }),
    session({ sessionId: 'c', title: 'read already', status: 'seen' }),
  ];

  it('emits no escape sequences at all when stdout is a pipe', () => {
    const io = fakeIo({ now: NOW });
    const out = renderText(sessions, { sessions, peers: [] }, OPTIONS, io);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b\[/);
    expect(out).toContain('approval');
    expect(out).toContain('working');
    expect(out).toContain('3 sessions');
    expect(out).toContain('1 blocked on you');
    // A state with nobody in it is not named at all — four zeroes read as noise.
    expect(out).not.toContain('0 dormant');
  });

  it('paints when stdout is a terminal', () => {
    const io = fakeIo({ now: NOW, isTty: true });
    // eslint-disable-next-line no-control-regex
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).toMatch(/\u001b\[/);
  });

  it('honours NO_COLOR on a terminal', () => {
    const io = fakeIo({ now: NOW, isTty: true, env: { NO_COLOR: '1' } });
    // eslint-disable-next-line no-control-regex
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).not.toMatch(/\u001b\[/);
  });

  it('omits the machine column when everything is local', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).not.toContain('MACHINE');
  });

  it('shows the machine column, by short host, once a peer is in the list', () => {
    const io = fakeIo({ now: NOW });
    const withPeer = [...sessions, session({ sessionId: 'd', peer: 'u@buildbox.example.com' })];
    const out = renderText(withPeer, { sessions: withPeer, peers: [] }, OPTIONS, io);
    expect(out).toContain('MACHINE');
    expect(out).toContain('buildbox');
    expect(out).not.toContain('buildbox.example.com');
  });

  it('says so when a session list is empty instead of printing a bare header', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText([], { sessions: [], peers: [] }, OPTIONS, io)).toContain('No sessions match');
  });

  it('reports an unreachable peer rather than dropping it silently', () => {
    const io = fakeIo({ now: NOW });
    const out = renderText(sessions, {
      sessions,
      peers: [{ peer: 'u@dead', reachable: false, error: 'publickey' }],
    }, { ...OPTIONS, peers: true }, io);
    expect(out).toContain('unreachable');
    expect(out).toContain('publickey');
  });

  it('says peers were not asked for, so an absent machine is never a mystery', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io))
      .toContain('Peer machines not included');
  });
});

describe('renderJson', () => {
  it('matches the documented version 1 contract', () => {
    const sessions = [session({ sessionId: 'local-1', status: 'approval' }), session({
      sessionId: 'remote-1', status: 'working', peer: 'u@buildbox.example.com',
    })];
    const json = renderJson(sessions, { sessions, peers: [] }, NOW);

    expect(json.version).toBe(1);
    expect(json.generatedAt).toBe(NOW.toISOString());
    // Every state is keyed, present at zero — a consumer can read a count without probing for it.
    // `stalled` joined the set additively: version 1 promises that fields are added and never
    // repurposed, and a consumer reading `counts.approval` is unaffected by a new sibling key.
    expect(json.counts).toEqual({
      total: 2, approval: 1, question: 0, finished: 0, working: 1, stalled: 0, seen: 0, dormant: 0,
    });
    expect(Object.keys(json.sessions[0]).sort()).toEqual([
      'ageSeconds', 'agent', 'blockedOnYou', 'local', 'machine', 'sessionId', 'status', 'title',
      'updatedAt', 'workspace',
    ]);
    expect(json.sessions[0]).toMatchObject({
      sessionId: 'local-1',
      agent: 'claude',
      status: 'approval',
      blockedOnYou: true,
      local: true,
      ageSeconds: 60,
      workspace: { name: 'session-sitter', path: '/home/u/session-sitter' },
    });
    expect(json.sessions[1])
      .toMatchObject({ local: false, machine: 'buildbox', status: 'working', blockedOnYou: false });
  });

  it('reports peer reachability with nulls, never with invented values', () => {
    const json = renderJson([], { sessions: [], peers: [{ peer: 'u@dead', reachable: false }] }, NOW);
    expect(json.peers).toEqual([
      { peer: 'u@dead', reachable: false, sessionCount: null, error: null },
    ]);
  });
});

describe('run', () => {
  const collect = async (): Promise<{ sessions: ClaudeSession[]; peers: [] }> => ({
    sessions: [session({ sessionId: 'only' })], peers: [],
  });

  it('prints help and exits 0', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--help'], io, collect)).toBe(0);
    expect(io.text()).toContain('session-sitter status');
  });

  it('prints valid JSON for --json', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--json'], io, collect)).toBe(0);
    expect(JSON.parse(io.text()).sessions[0].sessionId).toBe('only');
  });

  it('prints the table by default', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run([], io, collect)).toBe(0);
    expect(io.text()).toContain('SESSION');
  });
});

// ── The owner column ────────────────────────────────────────────────────────

describe('--owners', () => {
  const io = fakeIo({ now: NOW });
  const withOwners = { ...OPTIONS, owners: true };

  function worklist(owners: Map<string, Ownership>): Worklist {
    return { sessions: [], peers: [], owners };
  }

  it('names a window as a window', () => {
    const out = renderText(
      [session({ sessionId: 's1' })],
      worklist(new Map([['s1', { pid: 100, basis: 'holds', workspace: '/w' }]])),
      withOwners, io);
    expect(out).toContain('OWNER');
    expect(out).toContain('window 100');
  });

  /**
   * The distinction the column exists for. Printing the daemon as a window would tell a reader they
   * can type into the session, which is the one thing a daemon-held session cannot do.
   */
  it('names the daemon as the daemon', () => {
    const out = renderText(
      [session({ sessionId: 's1' })],
      worklist(new Map([['s1', { pid: 9001, basis: 'daemon', workspace: '' }]])),
      withOwners, io);
    expect(out).toContain('daemon 9001');
    expect(out).not.toContain('window 9001');
  });

  it('says read-only when nothing claims it', () => {
    const out = renderText(
      [session({ sessionId: 's1' })],
      worklist(new Map([['s1', { pid: null, basis: 'none', workspace: '' }]])),
      withOwners, io);
    expect(out).toContain('read-only');
  });

  it('says read-only for a session the map does not mention', () => {
    const out = renderText(
      [session({ sessionId: 's1' })], worklist(new Map()), withOwners, io);
    expect(out).toContain('read-only');
  });

  it('adds no column at all without the flag', () => {
    const out = renderText([session()], { sessions: [], peers: [] }, OPTIONS, io);
    expect(out).not.toContain('OWNER');
  });
});

describe('renderJson — the owner', () => {
  it('reports what can be written to, which is the question a caller has', () => {
    const json = renderJson(
      [session({ sessionId: 's1' })],
      { sessions: [], peers: [], owners: new Map([
        ['s1', { pid: 9001, basis: 'daemon', workspace: '' }],
      ]) },
      NOW);
    expect(json.sessions[0].owner).toEqual({
      kind: 'daemon', pid: 9001, basis: 'daemon', canWrite: false,
    });
  });

  it('reports a window as writable', () => {
    const json = renderJson(
      [session({ sessionId: 's1' })],
      { sessions: [], peers: [], owners: new Map([
        ['s1', { pid: 100, basis: 'workspace', workspace: '/w' }],
      ]) },
      NOW);
    expect(json.sessions[0].owner).toMatchObject({ kind: 'window', canWrite: true });
  });

  it('is null when nothing claims the session', () => {
    const json = renderJson(
      [session({ sessionId: 's1' })],
      { sessions: [], peers: [], owners: new Map() }, NOW);
    expect(json.sessions[0].owner).toBeNull();
  });

  /**
   * Absent, not null, when it was never asked for. A consumer that did not pass `--owners` must not
   * read a null as "nothing claims this session" — it means "nobody looked".
   */
  it('omits the key entirely when owners were not resolved', () => {
    const json = renderJson([session()], { sessions: [], peers: [] }, NOW);
    expect('owner' in json.sessions[0]).toBe(false);
  });
});
