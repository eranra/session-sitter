import { describe, expect, it, vi } from 'vitest';

// The launcher exists to talk to `vscode.commands`; everything else about it has to be coverable
// without an extension host, so the command surface is stubbed and recorded.
const executed: Array<{ command: string; args: unknown[] }> = [];
let executeThrows: Error | null = null;

vi.mock('vscode', () => ({
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      if (executeThrows !== null) { throw executeThrows; }
    },
  },
  extensions: { getExtension: () => undefined },
  window: {},
}));

// Static imports, not top-level `await import`: `vi.mock` is hoisted above them, so the stub is in
// place before the launcher's own `import 'vscode'` runs, and the CommonJS build this repo emits
// rejects top-level await outright.
import { VsCodeSessionLauncher } from '../../telegram/launcher';
import { firstMessage } from '../../telegram/newSession';

interface Harness {
  launcher: InstanceType<typeof VsCodeSessionLauncher>;
  sent: Array<[string, string]>;
  logs: string[];
}

/**
 * A launcher whose view of Claude's open panels is scripted.
 *
 * `panelsOverTime` is read once per probe, so a test can say "empty, then empty, then the new one
 * appeared" and exercise the wait rather than only its happy first read.
 */
function harness(opts: {
  panelsOverTime: string[][];
  sendStatus?: string;
  sendThrows?: Error;
  noSender?: boolean;
  appearTimeoutMs?: number;
} ): Harness {
  const sent: Array<[string, string]> = [];
  const logs: string[] = [];
  let probe = 0;
  const launcher = new VsCodeSessionLauncher(
    msg => { logs.push(msg); },
    undefined,
    {
      readOpen: async () => {
        const panels = opts.panelsOverTime[Math.min(probe, opts.panelsOverTime.length - 1)] ?? [];
        probe++;
        return { open: panels, panels, states: [], active: null, sidebar: false };
      },
      ...(opts.noSender === true ? {} : {
        sendToSession: async (id: string, text: string) => {
          sent.push([id, text]);
          if (opts.sendThrows !== undefined) { throw opts.sendThrows; }
          return opts.sendStatus ?? 'ok:matched';
        },
      }),
      host: 'buildbox',
      now: () => probe * 1000,
      sleep: async () => { /* the scripted probes advance time */ },
      appearTimeoutMs: opts.appearTimeoutMs ?? 8_000,
    });
  return { launcher, sent, logs };
}

describe('launching a Claude session', () => {
  it('opens a panel, names the session, and sends it a first message', async () => {
    executed.length = 0;
    executeThrows = null;
    const h = harness({ panelsOverTime: [['old'], ['old', 'new-1']] });

    const result = await h.launcher.launch('claude', '/work/app');

    expect(executed.map(e => e.command)).toEqual(['claude-vscode.primaryEditor.open']);
    // No session id argument: that would reopen an existing session rather than create one.
    expect(executed[0].args).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('new-1');
    expect(h.sent).toEqual([['new-1', firstMessage('buildbox')]]);
    expect(result.detail).toContain('topic is ready');
  });

  /**
   * The whole point of the change. Before this, the report promised a topic "once it writes its first
   * message" and nothing ever wrote one, so the promise never came true.
   */
  it('reads the open panels BEFORE opening, or it could not tell what is new', async () => {
    executed.length = 0;
    executeThrows = null;
    const probeOrder: string[] = [];
    const launcher = new VsCodeSessionLauncher(() => { /* quiet */ }, undefined, {
      readOpen: async () => {
        probeOrder.push(executed.length === 0 ? 'before-open' : 'after-open');
        return { open: [], panels: executed.length === 0 ? [] : ['new-1'], states: [], active: null, sidebar: false };
      },
      sendToSession: async () => 'ok:matched',
      sleep: async () => { /* no waiting */ },
    });

    await launcher.launch('claude', '/work/app');
    expect(probeOrder[0]).toBe('before-open');
  });

  it('waits for the panel to register, rather than giving up on the first read', async () => {
    executed.length = 0;
    executeThrows = null;
    // Not there, not there, then there.
    const h = harness({ panelsOverTime: [[], [], [], ['new-1']] });
    const result = await h.launcher.launch('claude', '/work/app');
    expect(result.sessionId).toBe('new-1');
  });

  it('gives up at its deadline and says the panel is open anyway', async () => {
    executed.length = 0;
    executeThrows = null;
    const h = harness({ panelsOverTime: [['old']], appearTimeoutMs: 1 });

    const result = await h.launcher.launch('claude', '/work/app');

    // `ok`, because the panel *is* open. Reporting a failure would send someone looking for a window
    // sitting in front of them.
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.detail).toContain('could not identify the session');
    expect(h.sent).toEqual([]);
  });

  it('refuses to guess when two sessions appear at once', async () => {
    executed.length = 0;
    executeThrows = null;
    const h = harness({ panelsOverTime: [[], ['a', 'b']] });

    const result = await h.launcher.launch('claude', '/work/app');

    expect(result.sessionId).toBeUndefined();
    expect(result.detail).toContain('2 sessions appeared at once');
    // A first message into the wrong conversation is worse than none.
    expect(h.sent).toEqual([]);
  });

  it('reports the open failing as a failure, distinctly', async () => {
    executed.length = 0;
    executeThrows = new Error('no editor');
    const h = harness({ panelsOverTime: [[]] });

    const result = await h.launcher.launch('claude', '/work/app');

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Could not start a Claude session in app');
    executeThrows = null;
  });

  describe('when the first message does not land', () => {
    it('still returns the id, so a topic can be made for it', async () => {
      executed.length = 0;
      executeThrows = null;
      const h = harness({ panelsOverTime: [[], ['new-1']], sendStatus: 'ambiguous:3' });

      const result = await h.launcher.launch('claude', '/work/app');

      // The session exists and is identified; only the message failed. A topic is still worth having.
      expect(result.sessionId).toBe('new-1');
      expect(result.detail).toContain('first message did not land');
      expect(result.detail).toContain('ambiguous:3');
    });

    it('says so when no sender is wired up, rather than failing silently', async () => {
      executed.length = 0;
      executeThrows = null;
      const h = harness({ panelsOverTime: [[], ['new-1']], noSender: true });
      const result = await h.launcher.launch('claude', '/work/app');
      expect(result.detail).toContain('no Claude sender is wired up');
    });

    it('survives a sender that throws', async () => {
      executed.length = 0;
      executeThrows = null;
      const h = harness({
        panelsOverTime: [[], ['new-1']], sendThrows: new Error('inspector detached'),
      });
      const result = await h.launcher.launch('claude', '/work/app');
      expect(result.sessionId).toBe('new-1');
      expect(result.detail).toContain('inspector detached');
    });
  });

  it('treats an unreachable manager as no panels, and keeps going', async () => {
    executed.length = 0;
    executeThrows = null;
    const launcher = new VsCodeSessionLauncher(() => { /* quiet */ }, undefined, {
      readOpen: async () => { throw new Error('ext-not-found'); },
      sendToSession: async () => 'ok:matched',
      sleep: async () => { /* no waiting */ },
      appearTimeoutMs: 1,
      now: (() => { let t = 0; return () => (t += 10); })(),
    });
    const result = await launcher.launch('claude', '/work/app');
    // The panel was still opened, so this is the "could not identify" case, not a crash.
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeUndefined();
  });
});

describe('launching a Bob session', () => {
  it('reports honestly that Bob is not installed', async () => {
    executed.length = 0;
    executeThrows = null;
    const h = harness({ panelsOverTime: [[]] });
    const result = await h.launcher.launch('bob', '/work/app');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Bob is not installed');
    // Bob's path must not open a Claude panel on the way.
    expect(executed).toEqual([]);
  });

  it('never claims a session id, because startTask returns none', async () => {
    executed.length = 0;
    const h = harness({ panelsOverTime: [[]] });
    const result = await h.launcher.launch('bob', '/work/app');
    expect(result.sessionId).toBeUndefined();
  });
});
