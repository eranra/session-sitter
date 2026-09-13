import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../SessionManager';

// Minimal VS Code stubs — only what SessionManager's constructor touches.
vi.mock('vscode', () => {
  const EventEmitter = class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  };
  const FileSystemWatcher = class {
    onDidCreate = vi.fn();
    onDidChange = vi.fn();
    onDidDelete = vi.fn();
    dispose = vi.fn();
  };
  return {
    EventEmitter,
    workspace: {
      createFileSystemWatcher: () => new FileSystemWatcher(),
    },
    Uri: { file: (p: string) => p },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
  };
});

// Helper: build a fake ExtensionContext with a no-op subscriptions array.
function makeContext() {
  return { subscriptions: { push: vi.fn() } } as unknown as import('vscode').ExtensionContext;
}

// Helper: write JSONL content to a temp file and return its path.
async function writeTempJsonl(dir: string, name: string, lines: object[]): Promise<string> {
  const filePath = path.join(dir, `${name}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

// Access private methods via cast — avoids modifying production code.
type PrivateManager = {
  _parseSessionFile(filePath: string): Promise<import('../SessionManager').ClaudeSession | null>;
};

describe('SessionManager._parseSessionFile', () => {
  let tmpDir: string;
  let manager: PrivateManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-test-'));
    // Temporarily point _projectsDir to tmpDir so constructor's _scanSessions
    // operates on a clean directory.
    const sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
    manager = sm as unknown as PrivateManager;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a file with no user record', async () => {
    const file = await writeTempJsonl(tmpDir, 'empty-session', [
      { type: 'system', content: 'init' },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result).toBeNull();
  });

  it('parses session id from filename', async () => {
    const id = 'abc12345-0000-0000-0000-000000000001';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', cwd: '/home/user/my-project', message: { content: 'Hello world' } },
      { type: 'assistant', message: { content: 'Hi there' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.sessionId).toBe(id);
  });

  it('extracts projectName from cwd', async () => {
    const file = await writeTempJsonl(tmpDir, 'session-a', [
      { type: 'user', cwd: '/home/user/my-project', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: 'Hi' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.projectName).toBe('my-project');
    expect(result?.projectPath).toBe('/home/user/my-project');
  });

  it('uses ai-title when present instead of raw user message', async () => {
    const file = await writeTempJsonl(tmpDir, 'ai-titled', [
      { type: 'user', cwd: '/p', message: { content: 'raw first message' } },
      { type: 'assistant', message: { content: 'ok' } },
      { type: 'ai-title', sessionId: 'ai-titled', aiTitle: 'Test a new session' },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('Test a new session');
  });

  it('falls back to user message when ai-title is absent', async () => {
    const file = await writeTempJsonl(tmpDir, 'no-ai-title', [
      { type: 'user', cwd: '/p', message: { content: 'raw first message' } },
      { type: 'assistant', message: { content: 'ok' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('raw first message');
  });

  it('truncates title to 60 characters', async () => {
    const longMsg = 'A'.repeat(100);
    const file = await writeTempJsonl(tmpDir, 'session-b', [
      { type: 'user', cwd: '/p', message: { content: longMsg } },
      { type: 'assistant', message: { content: 'ok' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('A'.repeat(60));
  });

  it('handles array content blocks', async () => {
    const file = await writeTempJsonl(tmpDir, 'session-c', [
      {
        type: 'user',
        cwd: '/p',
        message: {
          content: [
            { type: 'text', text: 'Block message' },
            { type: 'image', data: '...' },
          ],
        },
      },
      { type: 'assistant', message: { content: 'Got it' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('Block message');
  });

  describe('status detection', () => {
    it('new session: last record is a user prompt → working', async () => {
      const file = await writeTempJsonl(tmpDir, 'new-session', [
        { type: 'user', cwd: '/p', message: { content: 'test a new session' } },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working');
    });

    it('completed session: last record is assistant, old file → finished', async () => {
      const file = await writeTempJsonl(tmpDir, 'done-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'done' } },
      ]);
      // Back-date mtime so the file looks older than the 30-second active window.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('finished');
    });

    it('recent assistant record → working (still streaming)', async () => {
      const file = await writeTempJsonl(tmpDir, 'recent-assistant', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'working...' } },
      ]);
      // File is freshly written (within 30 s) → still working, not finished.
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working');
    });

    it('assistant tool_use that went quiet → approval, not a running tool', async () => {
      const file = await writeTempJsonl(tmpDir, 'tool-in-content', [
        { type: 'user', cwd: '/p', message: { content: 'run bash' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Running...' },
              { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
            ],
          },
        },
      ]);
      // Quiet for 60 s with an unanswered tool call. A tool that is really executing keeps the
      // transcript moving; one sitting on a permission prompt writes nothing — so this is the
      // session that used to spin green forever while actually waiting on the user.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('approval');
    });

    it('tool running: a fresh tool_use record → working', async () => {
      const file = await writeTempJsonl(tmpDir, 'active-session', [
        { type: 'user', cwd: '/p', message: { content: 'run a tool' } },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working');
    });

    it('tool result received: a fresh tool_result → working', async () => {
      const file = await writeTempJsonl(tmpDir, 'active-session-2', [
        { type: 'user', cwd: '/p', message: { content: 'run a tool' } },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working');
    });

    it('walks backward past unknown tail record types', async () => {
      // File has a user record for title extraction, but the tail window only
      // contains unknown record types — scanner finds none of the known types
      // and defaults to idle.
      const file = await writeTempJsonl(tmpDir, 'unknown-session', [
        { type: 'user', cwd: '/p', message: { content: 'hi' } },
        { type: 'queue-operation', data: {} },
      ]);
      // queue-operation is unknown; scanning backward hits 'user' → waiting.
      // To get the fall-through-to-idle path we'd need a file whose entire
      // tail has no user/assistant/tool_use/tool_result records.  Verify the
      // scan-backward-past-unknown behavior instead:
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working'); // user record is the last known
    });

    // ── Not every `type: "user"` record is the user typing a prompt ─────────────
    // Claude Code writes tool results and synthetic markers as user-type records too.
    // Treating those as "user sent a message, no reply yet" pins a finished session in the
    // active worklist for weeks; skipping past a tool result is worse, because the walk then
    // reaches the call it answered and reports a completed call as a pending approval.

    it('interrupted session: synthetic [Request interrupted by user] is not a prompt', async () => {
      const file = await writeTempJsonl(tmpDir, 'interrupted-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'on it' } },
        { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      ]);
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('finished');
    });

    it('interrupted session: the "for tool use" variant is not a prompt either', async () => {
      const file = await writeTempJsonl(tmpDir, 'interrupted-tool-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'on it' } },
        { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
      ]);
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('finished');
    });

    it('a month-old transcript ending on an interrupt does not read as pending', async () => {
      // The exact real-world shape that kept a month-old session in the active list:
      // assistant tool_use -> tool-result user record -> last-prompt -> interrupt marker.
      const file = await writeTempJsonl(tmpDir, 'real-world-stale', [
        { type: 'user', cwd: '/p', message: { content: 'look on the CI run and explain' } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        },
        {
          type: 'user',
          toolUseResult: { stdout: 'file contents' },
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
        },
        { type: 'last-prompt' },
        { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      ]);
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('finished');
    });

    it('injected isMeta record is not a prompt', async () => {
      // Skill loads and scheduled prompts arrive as isMeta user records, not user typing.
      const file = await writeTempJsonl(tmpDir, 'meta-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'done' } },
        { type: 'user', isMeta: true, message: { content: 'Base directory for this skill: /x' } },
      ]);
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('finished');
    });

    it('a tool result that came back and then went quiet is dormant, not busy', async () => {
      // The result answered the call above it, so nothing is pending — and nothing has been
      // written for a minute, so nothing is running either. It is an abandoned turn.
      const file = await writeTempJsonl(tmpDir, 'tool-result-user-record', [
        { type: 'user', cwd: '/p', message: { content: 'run a tool' } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        },
        {
          type: 'user',
          toolUseResult: { stdout: 'ok' },
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        },
      ]);
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('dormant');
    });

    it('a real user prompt after an interrupt reads as working', async () => {
      const file = await writeTempJsonl(tmpDir, 'reprompt-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'on it' } },
        { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
        { type: 'user', message: { content: 'actually do this instead' } },
      ]);
      // Inside the two-minute prompt window: the agent has not answered yet, but may still.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('working');
    });

    it('a prompt nobody ever answered eventually goes quiet', async () => {
      const file = await writeTempJsonl(tmpDir, 'abandoned-prompt', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
      ]);
      const old = new Date(Date.now() - 10 * 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('dormant');
    });

    it('an unanswered question reads as a question however long it has waited', async () => {
      const file = await writeTempJsonl(tmpDir, 'question-session', [
        { type: 'user', cwd: '/p', message: { content: 'which one?' } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] },
        },
      ]);
      const old = new Date(Date.now() - 3 * 3600_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('question');
    });

    it('no known record types at all defaults to dormant', async () => {
      // Construct a session whose first user record appears early (so we get
      // a title), but whose tail contains only unrecognised record types.
      // We achieve this by writing the user line first, then appending enough
      // queue-operation lines to push the user line outside the 2 KB tail window.
      const userLine = JSON.stringify({
        type: 'user', cwd: '/p', message: { content: 'early message' },
      });
      // Each queue-operation line is ~70 bytes; 500 × 70 = ~35 KB > 32 KB tail.
      const unknownLines = Array.from({ length: 500 }, (_, i) =>
        JSON.stringify({ type: 'queue-operation', seq: i, padding: 'x'.repeat(50) })
      );
      const filePath = path.join(tmpDir, 'no-known-tail.jsonl');
      await fs.promises.writeFile(
        filePath,
        [userLine, ...unknownLines].join('\n') + '\n',
        'utf8',
      );
      // Back-date mtime so the file looks older than the 30-second active window.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(filePath, old, old);
      const result = await manager._parseSessionFile(filePath);
      expect(result?.status).toBe('dormant');
    });
  });
});

describe('SessionManager.getRecentExchanges', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-preview-'));
    sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
  }

  it('returns [] for an unknown session id', async () => {
    const result = await sm.getRecentExchanges('does-not-exist');
    expect(result).toEqual([]);
  });

  it('returns user and assistant exchanges in chronological order', async () => {
    const id = 'preview-order';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'First question' }, timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] }, timestamp: '2024-01-01T00:00:01.000Z' },
      { type: 'user', message: { content: 'Second question' }, timestamp: '2024-01-01T00:00:02.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Second answer' }] }, timestamp: '2024-01-01T00:00:03.000Z' },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', text: 'First question', timestamp: '2024-01-01T00:00:00.000Z' });
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'First answer' });
    expect(result[2]).toMatchObject({ role: 'user', text: 'Second question' });
    expect(result[3]).toMatchObject({ role: 'assistant', text: 'Second answer' });
  });

  it('returns at most 6 records (3 user + 3 assistant)', async () => {
    const id = 'preview-cap';
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'user', message: { content: `Question ${i}` } });
      lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `Answer ${i}` }] } });
    }
    const file = await writeTempJsonl(tmpDir, id, lines);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({ role: 'user', text: 'Question 2' });
  });

  it('skips tool_use and tool_result records', async () => {
    const id = 'preview-skip-tools';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Run a command' } },
      { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.role === 'user' || r.role === 'assistant')).toBe(true);
  });

  it('skips assistant records that contain only tool_use blocks (no text)', async () => {
    const id = 'preview-skip-tool-only-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Do something' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'All done.' });
  });

  // The Telegram mirror is the caller that wants these. A session that spends ten minutes editing
  // files says nothing in that time, and a topic showing nothing reads as a session that has stopped.
  it('returns tool-only assistant records as tool turns when asked for them', async () => {
    const id = 'preview-tool-turns';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Fix the sort' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/app/src/sort.ts' } },
      ] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { includeTools: true });
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      role: 'assistant', kind: 'tool', text: 'Edit(/w/app/src/sort.ts)',
    });
    // The spoken turns are untouched — the kind is what tells the mirror to sample rather than post.
    expect(result[2].kind).toBeUndefined();
  });

  it('names every tool of a batched record, so a parallel call is not understated', async () => {
    const id = 'preview-tool-batch';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'make check\nmake guards' } },
      ] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { includeTools: true });
    // First line of the command only: a heredoc would otherwise become the flood sampling avoids.
    expect(result[0].text).toBe('Read(a.ts), Bash(make check)');
  });

  it('leaves tool records out unless they are asked for', async () => {
    const id = 'preview-tool-turns-off';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
      ] } },
    ]);
    seedPath(id, file);
    expect(await sm.getRecentExchanges(id)).toEqual([]);
  });

  // The mirror resumes from the last turn it posted, so a window barely deeper than one pass makes
  // it recover by timestamp constantly — and a window it cannot see past loses turns outright.
  it('returns as many turns as the caller asks for', async () => {
    const id = 'preview-limit';
    const lines = Array.from({ length: 40 }, (_, i) => (
      { type: 'user', message: { content: `Question ${i}` } }));
    const file = await writeTempJsonl(tmpDir, id, lines);
    seedPath(id, file);
    expect(await sm.getRecentExchanges(id, { limit: 30 })).toHaveLength(30);
    expect(await sm.getRecentExchanges(id)).toHaveLength(6);
  });

  it('falls back to the default depth for a limit that is not a usable number', async () => {
    const id = 'preview-limit-bad';
    const lines = Array.from({ length: 10 }, (_, i) => (
      { type: 'user', message: { content: `Question ${i}` } }));
    const file = await writeTempJsonl(tmpDir, id, lines);
    seedPath(id, file);
    expect(await sm.getRecentExchanges(id, { limit: 0 })).toHaveLength(1);
    expect(await sm.getRecentExchanges(id, { limit: NaN })).toHaveLength(6);
  });

  it('truncates user text longer than 150 chars', async () => {
    const id = 'preview-trunc-user';
    const longText = 'U'.repeat(200);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: longText } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
  });

  it('truncates assistant text longer than 250 chars', async () => {
    const id = 'preview-trunc-assistant';
    const longText = 'A'.repeat(300);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    const assistantEntry = result.find(r => r.role === 'assistant');
    expect(assistantEntry?.text).toBe('A'.repeat(250) + '…');
  });

  it('handles assistant with plain string content (not array)', async () => {
    const id = 'preview-string-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: 'Hi there' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result.find(r => r.role === 'assistant')?.text).toBe('Hi there');
  });

  it('omits timestamp when not present in the record', async () => {
    const id = 'preview-no-ts';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'No timestamp here' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].timestamp).toBeUndefined();
  });
});

// ── Helper: create a temporary Bob SQLite DB ─────────────────────────────────

import { execFileSync } from 'child_process';

function createBobDb(dbPath: string): void {
  execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect('${dbPath}')
conn.execute("""
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id TEXT,
    title TEXT,
    status TEXT,
    first_message TEXT,
    directory TEXT,
    version TEXT,
    git_sha TEXT,
    git_branch TEXT,
    env TEXT,
    costs TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    time_archived INTEGER,
    locked_by TEXT,
    lock_lease_until INTEGER,
    approval_config TEXT,
    message_queue TEXT,
    task_type TEXT,
    last_error TEXT,
    is_pinned INTEGER
  )
""")
conn.execute("""
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    role TEXT,
    data TEXT,
    created_at INTEGER
  )
""")
conn.commit()
conn.close()
`]);
}

function insertBobTask(dbPath: string, task: {
  id: string; projectId: string; title: string; status: string;
  firstMessage: string; updatedAt: number; env?: string;
}): void {
  const env = task.env ?? JSON.stringify({ workspace: task.projectId.replace('file:', ''), staticEnvInfo: { primaryWorkspace: task.projectId.replace('file:', '') } });
  execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect('${dbPath}')
conn.execute(
    "INSERT INTO tasks (id, project_id, title, status, first_message, created_at, updated_at, env) VALUES (?,?,?,?,?,?,?,?)",
    ('${task.id}', '${task.projectId}', ${JSON.stringify(task.title)}, '${task.status}', ${JSON.stringify(task.firstMessage)}, ${task.updatedAt}, ${task.updatedAt}, ${JSON.stringify(env)})
)
conn.commit()
conn.close()
`]);
}

function insertBobMessage(dbPath: string, msg: {
  id: string; taskId: string; role: string; content: string; ts: number;
}): void {
  execFileSync('python3', ['-c', `
import sqlite3, json
conn = sqlite3.connect('${dbPath}')
conn.execute(
    "INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?,?,?,?,?)",
    ('${msg.id}', '${msg.taskId}', '${msg.role}', json.dumps({'role':'${msg.role}','content':${JSON.stringify(msg.content)}}), ${msg.ts})
)
conn.commit()
conn.close()
`]);
}

type PrivateManagerBob = {
  _parseSessionFile(filePath: string): Promise<import('../SessionManager').ClaudeSession | null>;
  _scanBobSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _scanSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _projectsDir: string;
  _bobDbPath: string;
};

describe('SessionManager.getRecentExchanges (Bob)', () => {
  let tmpDir: string;
  let sm: SessionManager;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-preview-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._bobDbPath = dbPath;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedBobSession(sessionId: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, sessionId);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob'> })
      ._sessionSources.set(sessionId, 'bob');
  }

  it('extracts user and assistant exchanges from messages table', async () => {
    const id = 'bob-preview-1';
    seedBobSession(id);
    insertBobMessage(dbPath, { id: 'm1', taskId: id, role: 'user', content: 'Hello Bob', ts: 1000 });
    insertBobMessage(dbPath, { id: 'm2', taskId: id, role: 'assistant', content: 'Bob response', ts: 2000 });
    insertBobMessage(dbPath, { id: 'm3', taskId: id, role: 'user', content: 'Second user message', ts: 3000 });
    insertBobMessage(dbPath, { id: 'm4', taskId: id, role: 'assistant', content: 'Second Bob response', ts: 4000 });

    const result = await sm.getRecentExchanges(id);
    expect(result.length).toBeGreaterThan(0);
    const userExchanges = result.filter(e => e.role === 'user');
    const assistantExchanges = result.filter(e => e.role === 'assistant');
    expect(userExchanges[0].text).toBe('Hello Bob');
    expect(assistantExchanges[0].text).toBe('Bob response');
  });

  it('returns [] for unknown sessionId', async () => {
    expect(await sm.getRecentExchanges('not-bob')).toEqual([]);
  });

  it('truncates long user messages to 150 chars with ellipsis', async () => {
    const id = 'bob-trunc-user';
    seedBobSession(id);
    insertBobMessage(dbPath, { id: 'm1', taskId: id, role: 'user', content: 'U'.repeat(200), ts: 1000 });
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
  });

  it('truncates long assistant messages to 250 chars with ellipsis', async () => {
    const id = 'bob-trunc-asst';
    seedBobSession(id);
    insertBobMessage(dbPath, { id: 'm1', taskId: id, role: 'user', content: 'Q', ts: 1000 });
    insertBobMessage(dbPath, { id: 'm2', taskId: id, role: 'assistant', content: 'A'.repeat(300), ts: 2000 });
    const result = await sm.getRecentExchanges(id);
    const asst = result.find(e => e.role === 'assistant');
    expect(asst?.text).toBe('A'.repeat(250) + '…');
  });
});

describe('SessionManager._scanBobSessions', () => {
  let tmpDir: string;
  let sm: SessionManager;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-scan-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._bobDbPath = dbPath;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when DB does not exist', async () => {
    (sm as unknown as PrivateManagerBob)._bobDbPath = '/nonexistent/bob.db';
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    expect(sessions).toEqual([]);
  });

  it('skips tasks with no first_message', async () => {
    insertBobTask(dbPath, { id: 'no-msg', projectId: 'file:/proj', title: '', status: 'active', firstMessage: '', updatedAt: Date.now() });
    // The query filters WHERE first_message IS NOT NULL, and title || first_message must be non-empty
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    expect(sessions.find(s => s.sessionId === 'no-msg')).toBeUndefined();
  });

  it('maps running status to working', async () => {
    insertBobTask(dbPath, { id: 'task-running', projectId: 'file:/proj', title: 'Running task', status: 'running', firstMessage: 'Running task', updatedAt: Date.now() });
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    const s = sessions.find(s => s.sessionId === 'task-running');
    expect(s?.status).toBe('working');
  });

  it("maps Bob's active status — which means finished — to finished", async () => {
    insertBobTask(dbPath, { id: 'task-idle', projectId: 'file:/proj', title: 'Done task', status: 'active', firstMessage: 'Done task', updatedAt: Date.now() });
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    const s = sessions.find(s => s.sessionId === 'task-idle');
    expect(s?.status).toBe('finished');
  });

  it('extracts projectPath from env.staticEnvInfo.primaryWorkspace', async () => {
    const env = JSON.stringify({ workspace: '/proj', staticEnvInfo: { primaryWorkspace: '/home/user/my-project' } });
    insertBobTask(dbPath, { id: 'task-proj', projectId: 'file:/proj', title: 'Task', status: 'active', firstMessage: 'Task', updatedAt: Date.now(), env });
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    const s = sessions.find(s => s.sessionId === 'task-proj');
    expect(s?.projectPath).toBe('/home/user/my-project');
    expect(s?.projectName).toBe('my-project');
    expect(s?.source).toBe('bob');
  });

  it('falls back to project_id for projectPath when env has no workspace', async () => {
    const env = JSON.stringify({});
    insertBobTask(dbPath, { id: 'task-fallback', projectId: 'file:/home/user/fallback-proj', title: 'Fallback', status: 'active', firstMessage: 'Fallback', updatedAt: Date.now(), env });
    const sessions = await (sm as unknown as PrivateManagerBob)._scanBobSessions();
    const s = sessions.find(s => s.sessionId === 'task-fallback');
    expect(s?.projectPath).toBe('/home/user/fallback-proj');
  });
});

describe('SessionManager._scanSessions merges Claude and Bob sessions', () => {
  let tmpDir: string;
  let sm: SessionManager;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'merged-test-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._projectsDir = path.join(tmpDir, 'claude-projects');
    (sm as unknown as PrivateManagerBob)._bobDbPath = dbPath;
    // Point Codex + Chat at nonexistent paths so this merge test only observes
    // Claude and Bob sources, regardless of what exists on the host machine.
    (sm as unknown as PrivateManagerCodex)._codexSessionsDir = path.join(tmpDir, 'no-codex');
    (sm as unknown as PrivateManagerCodex)._codexIndexPath = path.join(tmpDir, 'no-codex-index');
    (sm as unknown as PrivateManagerChat)._vscodeUserDir = path.join(tmpDir, 'no-vscode');
    await fs.promises.mkdir(path.join(tmpDir, 'claude-projects'), { recursive: true });
  });

  afterEach(async () => {
    // retries + retryDelay guard against a race with the SessionManager's
    // constructor-initiated background scans (Bob subprocess may leave
    // sqlite journal files, Codex/Chat scans may still be walking).
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns both claude and bob sessions sorted by updatedAt descending', async () => {
    const olderTs = Date.now() - 10_000;

    // Bob task (back-dated to be older)
    insertBobTask(dbPath, { id: 'bob-uuid-1', projectId: 'file:/home/user/proj', title: 'Bob task', status: 'active', firstMessage: 'Bob task', updatedAt: olderTs });

    // Claude session (just written → newer mtime)
    const claudeDir = path.join(tmpDir, 'claude-projects', '-home-user-proj');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await writeTempJsonl(claudeDir, 'claude-uuid-1', [
      { type: 'user', cwd: '/home/user/proj', message: { content: 'Claude task' } },
    ]);

    const sessions = await (sm as unknown as PrivateManagerBob)._scanSessions();

    expect(sessions.length).toBe(2);
    expect(sessions[0].source).toBe('claude');
    expect(sessions[1].source).toBe('bob');
    expect(sessions[0].title).toBe('Claude task');
    expect(sessions[1].title).toBe('Bob task');
  });
});

// ── SessionManager._scanCodexSessions ────────────────────────────────────────
type PrivateManagerCodex = {
  _scanCodexSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _codexSessionsDir: string;
  _codexIndexPath: string;
};

describe('SessionManager._scanCodexSessions', () => {
  let tmpDir: string;
  let codexSessionsDir: string;
  let codexIndexPath: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-scan-'));
    codexSessionsDir = path.join(tmpDir, '.codex', 'sessions');
    codexIndexPath = path.join(tmpDir, '.codex', 'session_index.jsonl');
    await fs.promises.mkdir(path.join(codexSessionsDir, '2026', '07', '13'), { recursive: true });
    sm = new SessionManager(makeContext());
    // Override the paths post-construction, same pattern as PrivateManagerBob tests.
    (sm as unknown as PrivateManagerCodex)._codexSessionsDir = codexSessionsDir;
    (sm as unknown as PrivateManagerCodex)._codexIndexPath = codexIndexPath;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts sessions using session_index.jsonl for title + updated_at', async () => {
    const rollout = path.join(codexSessionsDir, '2026', '07', '13', 'rollout-2026-07-13T10-00-00-abc.jsonl');
    await fs.promises.writeFile(
      rollout,
      JSON.stringify({
        timestamp: '2026-07-13T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'codex-1', cwd: '/home/u/proj' },
      }) + '\n',
    );
    await fs.promises.writeFile(
      codexIndexPath,
      JSON.stringify({ id: 'codex-1', thread_name: 'Fix the parser', updated_at: '2026-07-13T10:05:00Z' }) + '\n',
    );

    const results = await (sm as unknown as PrivateManagerCodex)._scanCodexSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 'codex-1',
      title: 'Fix the parser',
      projectPath: '/home/u/proj',
      projectName: 'proj',
      source: 'codex',
      // No liveness signal exists for Codex, so we say so rather than implying it finished.
      status: 'dormant',
    });
    expect(results[0].updatedAt.toISOString()).toBe('2026-07-13T10:05:00.000Z');
  });

  it('falls back to file mtime and cwd basename when index has no entry', async () => {
    const rollout = path.join(codexSessionsDir, '2026', '07', '13', 'rollout-2026-07-13T10-00-00-def.jsonl');
    await fs.promises.writeFile(
      rollout,
      JSON.stringify({
        timestamp: '2026-07-13T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'codex-2', cwd: '/home/u/other-proj' },
      }) + '\n',
    );
    // No session_index.jsonl written.

    const results = await (sm as unknown as PrivateManagerCodex)._scanCodexSessions();

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('codex-2');
    expect(results[0].title).toBe('other-proj');
    expect(results[0].projectName).toBe('other-proj');
    expect(results[0].source).toBe('codex');
  });

  it('handles a rollout whose line-0 session_meta record is larger than 4 KB', async () => {
    // Regression: real Codex CLI embeds base_instructions in session_meta,
    // pushing line 0 well past 4 KB. A fixed-buffer read would truncate and
    // JSON.parse would throw. This test locks in the progressive-read fix.
    const rollout = path.join(codexSessionsDir, '2026', '07', '13', 'rollout-2026-07-13T10-00-00-big.jsonl');
    const bigInstructions = 'A'.repeat(20_000); // 20 KB of padding inside payload
    const line0 = JSON.stringify({
      timestamp: '2026-07-13T10:00:00Z',
      type: 'session_meta',
      payload: { id: 'codex-big', cwd: '/home/u/big-proj', base_instructions: bigInstructions },
    });
    await fs.promises.writeFile(rollout, line0 + '\n{"type":"response_item","payload":{"role":"user"}}\n');
    await fs.promises.writeFile(
      codexIndexPath,
      JSON.stringify({ id: 'codex-big', thread_name: 'Big instructions', updated_at: '2026-07-13T10:05:00Z' }) + '\n',
    );

    const results = await (sm as unknown as PrivateManagerCodex)._scanCodexSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 'codex-big',
      title: 'Big instructions',
      projectPath: '/home/u/big-proj',
      source: 'codex',
    });
  });

  it('returns [] when the sessions directory does not exist', async () => {
    await fs.promises.rm(path.join(tmpDir, '.codex'), { recursive: true, force: true });
    const results = await (sm as unknown as PrivateManagerCodex)._scanCodexSessions();
    expect(results).toEqual([]);
  });
});

// ── SessionManager.getRecentExchanges (Codex) ────────────────────────────────
describe('SessionManager.getRecentExchanges (Codex)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-preview-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts user/assistant text from response_item records', async () => {
    const rollout = path.join(tmpDir, 'rollout-x.jsonl');
    const lines = [
      { timestamp: '2026-07-13T10:00:00Z', type: 'session_meta', payload: { id: 'cx-1', cwd: '/x' } },
      { timestamp: '2026-07-13T10:00:01Z', type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'Hello Codex' }] } },
      { timestamp: '2026-07-13T10:00:02Z', type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] } },
    ];
    await fs.promises.writeFile(rollout, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    // Seed the session maps directly (mirrors seedBobSession in the Bob preview tests).
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-1', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-1', 'codex');

    const ex = await sm.getRecentExchanges('cx-1');
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ role: 'user', text: 'Hello Codex' });
    expect(ex[1]).toMatchObject({ role: 'assistant', text: 'Hi there' });
  });
});

// ── SessionManager.exportSessionAsJson (Codex) ───────────────────────────────
describe('SessionManager.exportSessionAsJson (Codex)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-export-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the raw .jsonl path with a no-op cleanup for Codex sessions', async () => {
    const rollout = path.join(tmpDir, 'rollout.jsonl');
    await fs.promises.writeFile(rollout, '{"type":"session_meta","payload":{"id":"cx-e","cwd":"/x"}}\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-e', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'seen', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-e', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-e', 'codex');

    const out = await sm.exportSessionAsJson('cx-e');
    expect(out).not.toBeNull();
    expect(out!.filePath).toBe(rollout);
    // cleanup must be safe to invoke and NOT delete the source file.
    out!.cleanup();
    await expect(fs.promises.access(rollout)).resolves.toBeUndefined();
  });
});

// ── SessionManager._scanChatSessions ─────────────────────────────────────────
type PrivateManagerChat = {
  _scanChatSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _vscodeUserDir: string;
};

describe('SessionManager._scanChatSessions', () => {
  let tmpDir: string;
  let vscodeUserDir: string;
  let wsHash: string;
  let chatDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-scan-'));
    vscodeUserDir = path.join(tmpDir, 'User');
    wsHash = 'abc123';
    chatDir = path.join(vscodeUserDir, 'workspaceStorage', wsHash, 'chatSessions');
    await fs.promises.mkdir(chatDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(path.dirname(chatDir), 'workspace.json'),
      JSON.stringify({ folder: 'file:///home/u/my-proj' }),
    );
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerChat)._vscodeUserDir = vscodeUserDir;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts title from requests[0].message.text and folder from workspace.json', async () => {
    const chatFile = path.join(chatDir, 'sess-1.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'sess-1',
        creationDate: '2026-07-13T10:00:00Z',
        requests: [{ message: { text: 'How do I compile this project?' } }],
      },
    }) + '\n');

    const results = await (sm as unknown as PrivateManagerChat)._scanChatSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 'sess-1',
      title: 'How do I compile this project?',
      projectPath: '/home/u/my-proj',
      projectName: 'my-proj',
      source: 'chat',
      status: 'dormant',
    });
  });

  it("falls back to 'Chat in <basename>' when requests is empty", async () => {
    const chatFile = path.join(chatDir, 'sess-2.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: { sessionId: 'sess-2', requests: [] },
    }) + '\n');

    const results = await (sm as unknown as PrivateManagerChat)._scanChatSessions();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Chat in my-proj');
  });

  it("uses '(no workspace)' when workspace.json is missing", async () => {
    await fs.promises.rm(path.join(path.dirname(chatDir), 'workspace.json'));
    const chatFile = path.join(chatDir, 'sess-3.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: { sessionId: 'sess-3', requests: [{ message: { text: 'hi' } }] },
    }) + '\n');

    const results = await (sm as unknown as PrivateManagerChat)._scanChatSessions();
    expect(results[0].projectName).toBe('(no workspace)');
    expect(results[0].projectPath).toBe('');
  });

  it('returns [] when workspaceStorage does not exist', async () => {
    await fs.promises.rm(vscodeUserDir, { recursive: true, force: true });
    const results = await (sm as unknown as PrivateManagerChat)._scanChatSessions();
    expect(results).toEqual([]);
  });
});

// ── SessionManager.getRecentExchanges (Chat) ─────────────────────────────────
describe('SessionManager.getRecentExchanges (Chat)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-preview-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts user text and concatenated assistant response.value from requests[]', async () => {
    const chatFile = path.join(tmpDir, 'chat.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'ch-1',
        requests: [{
          message: { text: 'Explain flexbox' },
          response: [
            { kind: 'mcpServersStarting' },
            { value: 'Flexbox is ' },
            { value: 'a layout system.' },
          ],
          timestamp: 1721005200000,
        }],
      },
    }) + '\n');

    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-1', chatFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ch-1', 'chat');

    const ex = await sm.getRecentExchanges('ch-1');
    expect(ex.map(e => ({ role: e.role, text: e.text }))).toEqual([
      { role: 'user', text: 'Explain flexbox' },
      { role: 'assistant', text: 'Flexbox is a layout system.' },
    ]);
  });
});

// ── SessionManager.exportSessionAsJson (Chat) ────────────────────────────────
describe('SessionManager.exportSessionAsJson (Chat)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-export-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('produces a .chat.json envelope with expected keys and cleans up', async () => {
    const chatFile = path.join(tmpDir, 'chat.jsonl');
    await fs.promises.writeFile(chatFile, JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'ce-1',
        requests: [{ message: { text: 'hi' }, response: [{ value: 'hello' }] }],
      },
    }) + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ce-1', projectPath: '/x', projectName: 'x',
      title: 'hi', updatedAt: new Date('2026-07-13T10:00:00Z'), status: 'seen', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ce-1', chatFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ce-1', 'chat');

    const out = await sm.exportSessionAsJson('ce-1');
    expect(out).not.toBeNull();
    expect(out!.filePath).toMatch(/\.chat\.json$/);
    const written = JSON.parse(await fs.promises.readFile(out!.filePath, 'utf8'));
    expect(written).toMatchObject({
      session_id: 'ce-1',
      harness: 'chat',
      title: 'hi',
    });
    expect(written.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hi' }),
      expect.objectContaining({ role: 'assistant', content: 'hello' }),
    ]);
    // Cleanup removes the temp file.
    out!.cleanup();
    await expect(fs.promises.access(out!.filePath)).rejects.toThrow();
  });
});

// ── SessionManager._renderTranscriptAsMarkdown ───────────────────────────────
type PrivateManagerRenderer = {
  _renderTranscriptAsMarkdown(
    turns: Array<{ userText?: string; assistantText?: string; timestamp?: Date }>,
    meta: { title: string; source: 'Claude' | 'Bob' | 'Codex' | 'Chat'; sessionId: string },
  ): string;
};

describe('SessionManager._renderTranscriptAsMarkdown', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(makeContext());
  });

  it('renders a two-turn transcript with header, turn sections, and separators', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [
        { userText: 'Hello', assistantText: 'Hi there', timestamp: new Date('2026-07-20T10:00:00Z') },
        { userText: 'How are you?', assistantText: 'Good.', timestamp: new Date('2026-07-20T10:01:00Z') },
      ],
      { title: 'A conversation', source: 'Claude', sessionId: 'sess-abc' },
    );
    expect(md).toContain('# A conversation');
    expect(md).toContain('*Copied from Claude · session `sess-abc` · 2 turns.*');
    expect(md).toContain('## Turn 1  ·  2026-07-20 10:00:00');
    expect(md).toContain('**User:**\n\nHello');
    expect(md).toContain('**Assistant (Claude):**\n\nHi there');
    expect(md).toContain('## Turn 2  ·  2026-07-20 10:01:00');
  });

  it('omits the User/Assistant block for turns with no text on that side', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [{ userText: 'Half-turn', timestamp: new Date('2026-07-20T10:00:00Z') }],
      { title: 't', source: 'Chat', sessionId: 's' },
    );
    expect(md).toContain('**User:**\n\nHalf-turn');
    expect(md).not.toContain('**Assistant');
  });

  it('handles empty turns with an empty transcript body', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [],
      { title: 'empty', source: 'Bob', sessionId: 's' },
    );
    expect(md).toContain('· 0 turns.*');
    expect(md).not.toContain('## Turn 1');
  });

  it('uses "(no timestamp)" when timestamp is absent', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [{ userText: 'u', assistantText: 'a' }],
      { title: 't', source: 'Codex', sessionId: 's' },
    );
    expect(md).toContain('## Turn 1  ·  (no timestamp)');
  });
});

describe('SessionManager.exportFullTranscript', () => {
  it('returns null for a session that is not in _sessions', async () => {
    const sm = new SessionManager(makeContext());
    const result = await sm.exportFullTranscript('nonexistent');
    expect(result).toBeNull();
  });
});

// ── SessionManager.exportFullTranscript (Codex) ──────────────────────────────
describe('SessionManager.exportFullTranscript (Codex)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts all user/assistant response_items and drops function_call + session_meta', async () => {
    const rollout = path.join(tmpDir, 'rollout.jsonl');
    const lines = [
      { timestamp: '2026-07-20T10:00:00Z', type: 'session_meta', payload: { id: 'cx-full', cwd: '/x' } },
      { timestamp: '2026-07-20T10:00:01Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'First question' }] } },
      { timestamp: '2026-07-20T10:00:02Z', type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }] } },
      { timestamp: '2026-07-20T10:00:03Z', type: 'function_call', payload: { name: 'read_file', arguments: '{"p":"x"}' } },
      { timestamp: '2026-07-20T10:00:04Z', type: 'function_call_output', payload: { output: 'file contents' } },
      { timestamp: '2026-07-20T10:00:05Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Second question' }] } },
      { timestamp: '2026-07-20T10:00:06Z', type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Second answer' }] } },
    ];
    await fs.promises.writeFile(rollout, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-full', projectPath: '/x', projectName: 'x',
      title: 'Codex conversation', updatedAt: new Date('2026-07-20T10:00:06Z'), status: 'seen', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-full', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-full', 'codex');

    const md = await sm.exportFullTranscript('cx-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# Codex conversation');
    expect(md).toContain('*Copied from Codex · session `cx-full` · 2 turns.*');
    expect(md).toContain('First question');
    expect(md).toContain('First answer');
    expect(md).toContain('Second question');
    expect(md).toContain('Second answer');
    expect(md).not.toContain('read_file');
    expect(md).not.toContain('file contents');
  });

  it('drops response_item records with non-text roles or empty content', async () => {
    const rollout = path.join(tmpDir, 'rollout2.jsonl');
    await fs.promises.writeFile(rollout, [
      { type: 'session_meta', payload: { id: 'cx-2', cwd: '/x' } },
      { type: 'response_item', payload: { role: 'system', content: [{ type: 'input_text', text: 'system prompt' }] } },
      { type: 'response_item', payload: { role: 'user', content: [] } },
      { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'orphan reply' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-2', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'seen', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-2', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-2', 'codex');

    const md = await sm.exportFullTranscript('cx-2');
    expect(md).not.toBeNull();
    expect(md).not.toContain('system prompt');
    expect(md).toContain('orphan reply');
  });
});

// ── SessionManager.exportFullTranscript (Claude) ─────────────────────────────
describe('SessionManager.exportFullTranscript (Claude)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts user + assistant text; drops tool_use, tool_result, thinking', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    const events = [
      { type: 'user', timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'First user message' } },
      { type: 'assistant', timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Let me think' },
        { type: 'text', text: 'First assistant reply' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ]}},
      { type: 'user', timestamp: '2026-07-20T10:00:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
      ]}},
      { type: 'assistant', timestamp: '2026-07-20T10:00:03Z', message: { role: 'assistant', content: [
        { type: 'text', text: 'Second assistant reply' },
      ]}},
      { type: 'summary', summary: 'Session summary' },
    ];
    await fs.promises.writeFile(sessionFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cl-full', projectPath: '/x', projectName: 'x',
      title: 'A Claude chat', updatedAt: new Date('2026-07-20T10:00:03Z'), status: 'seen', source: 'claude',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cl-full', sessionFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cl-full', 'claude');

    const md = await sm.exportFullTranscript('cl-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# A Claude chat');
    expect(md).toContain('First user message');
    expect(md).toContain('First assistant reply');
    expect(md).toContain('Second assistant reply');
    expect(md).not.toContain('Let me think');
    expect(md).not.toContain('file contents');
    expect(md).not.toContain('Session summary');
  });

  it('handles string-form user content and array-form user content identically', async () => {
    const sessionFile = path.join(tmpDir, 'session2.jsonl');
    const events = [
      { type: 'user', message: { role: 'user', content: 'plain string form' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array form' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] } },
    ];
    await fs.promises.writeFile(sessionFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cl-2', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'seen', source: 'claude',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cl-2', sessionFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cl-2', 'claude');

    const md = await sm.exportFullTranscript('cl-2');
    expect(md).toContain('plain string form');
    expect(md).toContain('array form');
    expect(md).toContain('ack');
  });
});

// ── SessionManager.exportFullTranscript (Bob) ────────────────────────────────
describe('SessionManager.exportFullTranscript (Bob)', () => {
  let tmpDir: string;
  let dbPath: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-full-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._bobDbPath = dbPath;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts every message for a task in chronological order (not tail-sliced)', async () => {
    const id = 'bob-full-1';
    // Seven messages — well past the 6-cap of the preview extractor.
    for (let i = 1; i <= 7; i++) {
      insertBobMessage(dbPath, {
        id: `m${i}`, taskId: id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Msg ${i}`,
        ts: 1_000 * i,
      });
    }

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: id, projectPath: '/proj', projectName: 'proj',
      title: 'Bob conversation', updatedAt: new Date(7_000), status: 'seen', source: 'bob',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set(id, id);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set(id, 'bob');

    const md = await sm.exportFullTranscript(id);
    expect(md).not.toBeNull();
    expect(md).toContain('# Bob conversation');
    // Every message must appear — not truncated to the last 6.
    for (let i = 1; i <= 7; i++) {
      expect(md).toContain(`Msg ${i}`);
    }
    // Chronological: Msg 1 appears before Msg 7 in the markdown.
    expect(md!.indexOf('Msg 1')).toBeLessThan(md!.indexOf('Msg 7'));
  });
});

// ── SessionManager.exportFullTranscript (Chat) ───────────────────────────────
describe('SessionManager.exportFullTranscript (Chat)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('replays deltas, unwraps <userRequest>, concatenates response values', async () => {
    const chatFile = path.join(tmpDir, 'chat.jsonl');
    const wrapped = '<context>\nSystem stuff\n</context>\n<userRequest>\nActual user prose\n</userRequest>';
    const lines = [
      // Snapshot with empty requests
      { kind: 0, v: { sessionId: 'ch-full', customTitle: 'A Chat conversation', requests: [] } },
      // Push one request onto requests[]
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 1_753_000_000_000, response: [] }] },
      // Fill in response array via kind:1 update
      { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Hello ' }, { value: 'from Copilot.' }] },
      // Fill in the rendered user message
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { renderedUserMessage: [{ type: 1, text: wrapped }] } } },
    ];
    await fs.promises.writeFile(chatFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ch-full', projectPath: '/x', projectName: 'x',
      title: 'A Chat conversation', updatedAt: new Date(1_753_000_000_000), status: 'seen', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-full', chatFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ch-full', 'chat');

    const md = await sm.exportFullTranscript('ch-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# A Chat conversation');
    expect(md).toContain('Actual user prose');
    expect(md).not.toContain('<context>');
    expect(md).not.toContain('System stuff');
    expect(md).toContain('Hello from Copilot.');
  });

  it('returns a zero-turn transcript when the file cannot be read', async () => {
    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ch-missing', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'seen', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-missing', '/nonexistent/foo.jsonl');
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ch-missing', 'chat');
    const md = await sm.exportFullTranscript('ch-missing');
    expect(md).not.toBeNull();
    expect(md).toContain('· 0 turns.*');
  });
});

describe('SessionManager.getRecentExchanges full mode', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-full-'));
    sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
  }

  it('returns the whole assistant answer, not a 250-char preview', async () => {
    // The reason the feature exists: the Telegram mirror was reading the panel's preview text, so
    // no amount of message splitting downstream could show more than 250 characters.
    const id = 'full-assistant';
    const longText = 'A'.repeat(9000);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { full: true });
    expect(result[1].text).toBe(longText);
  });

  it('returns the whole user prompt too', async () => {
    // Not cosmetic: echo suppression compares the sent text against the transcript's, so a prompt
    // over 150 characters used to fail the match and be reposted as a duplicate.
    const id = 'full-user';
    const longText = 'U'.repeat(4000);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: longText } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { full: true });
    expect(result[0].text).toBe(longText);
  });

  it('joins every text block of an answer instead of taking the first', async () => {
    const id = 'full-blocks';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first thought' },
            { type: 'tool_use', id: 't1', name: 'bash', input: {} },
            { type: 'text', text: 'second thought' },
          ],
        },
      },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { full: true });
    expect(result[1].text).toBe('first thought\n\nsecond thought');
  });

  it('reads past the 32 KB preview window so a long answer is not lost entirely', async () => {
    // A single record bigger than the preview tail is not merely truncated: the window starts
    // mid-line, the JSON fails to parse, and the turn vanishes. Full mode must widen the read.
    const id = 'full-beyond-tail';
    const longText = 'A'.repeat(60_000);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    seedPath(id, file);
    const preview = await sm.getRecentExchanges(id);
    expect(preview.some(e => e.role === 'assistant')).toBe(false);
    const full = await sm.getRecentExchanges(id, { full: true });
    expect(full.some(e => e.role === 'assistant' && e.text === longText)).toBe(true);
  });

  it('still caps by default, so the panel and the auto-responder are untouched', async () => {
    const id = 'full-default-unchanged';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'U'.repeat(200) } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
    expect(result[1].text).toBe('A'.repeat(250) + '…');
  });

  it('keeps the timestamps and the chronological order it always had', async () => {
    const id = 'full-order';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'one' }, timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] }, timestamp: '2024-01-01T00:00:01.000Z' },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id, { full: true });
    expect(result.map(e => e.text)).toEqual(['one', 'two']);
    expect(result[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
  });
});
