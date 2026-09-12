/**
 * The poller that keeps the panel's view of the hook trail fresh.
 *
 * The logic it wraps is tested in `hookActivity.test.ts`. What is pinned here is the behaviour that
 * only a stateful poller can get wrong: never clearing the map on a failed read, and never repainting
 * for a change nobody can see.
 */

import { describe, expect, it, vi } from 'vitest';
import { HookActivityWatcher } from '../HookActivityWatcher';
import type { HookActivityRecord, HookDecisionRecord } from '../hookActivity';

const T0 = Date.parse('2026-09-12T10:00:00.000Z');

type Trail = { decisions: HookDecisionRecord[]; activity: HookActivityRecord[] };

const question = (sessionId: string): HookDecisionRecord => ({
  ts: new Date(T0).toISOString(), sessionId, tool: 'AskUserQuestion',
  decision: 'none', actor: 'human',
});

const ran = (sessionId: string, tool: string): HookActivityRecord => ({
  ts: new Date(T0 + 1_000).toISOString(), sessionId, tool,
  fingerprint: 'abc123', ok: true,
});

/** A watcher reading a trail the test controls, with a frozen clock. */
function watcher(read: () => Trail, log: (msg: string) => void = () => { }) {
  return new HookActivityWatcher(log, 60_000, read, () => T0 + 2_000);
}

describe('HookActivityWatcher', () => {
  it('exposes what the trail says about each session', () => {
    const w = watcher(() => ({ decisions: [question('s1')], activity: [] }));
    w.poll();
    expect(w.snapshot().get('s1')?.pending).toBe('question');
  });

  it('keeps the previous map when a read fails', () => {
    // The whole reason this is not a plain re-read. Clearing would turn one unreadable file into
    // "nothing is blocked", which is the false negative the design refuses to draw — and it is the
    // exact rule `PendingWatcher` follows for Bob.
    let fail = false;
    const w = watcher(() => {
      if (fail) { throw new Error('EACCES'); }
      return { decisions: [question('s1')], activity: [] };
    });

    w.poll();
    expect(w.snapshot().get('s1')?.pending).toBe('question');

    fail = true;
    w.poll();
    expect(w.snapshot().get('s1')?.pending).toBe('question');
  });

  it('logs a failed read rather than failing silently', () => {
    const lines: string[] = [];
    const w = watcher(() => { throw new Error('EACCES'); }, msg => lines.push(msg));
    w.poll();
    expect(lines.join('\n')).toContain('trail read failed');
  });

  it('repaints when a prompt appears, and again when it clears', () => {
    let trail: Trail = { decisions: [], activity: [] };
    const w = watcher(() => trail);
    const onChange = vi.fn();
    w.setOnChange(onChange);

    w.poll();
    const beforePrompt = onChange.mock.calls.length;

    trail = { decisions: [question('s1')], activity: [] };
    w.poll();
    expect(onChange.mock.calls.length).toBeGreaterThan(beforePrompt);

    const afterPrompt = onChange.mock.calls.length;
    trail = { decisions: [question('s1')], activity: [ran('s1', 'AskUserQuestion')] };
    w.poll();
    expect(onChange.mock.calls.length).toBeGreaterThan(afterPrompt);
  });

  it('does not repaint when only the running tool changed', () => {
    // `tool` changes on every tool call. A repaint per tool call across every open session is the
    // cost the signature exists to avoid — the label is picked up by the next scheduled paint.
    let trail: Trail = { decisions: [], activity: [ran('s1', 'Read')] };
    const w = watcher(() => trail);
    w.poll();

    const onChange = vi.fn();
    w.setOnChange(onChange);
    trail = { decisions: [], activity: [ran('s1', 'Bash')] };
    w.poll();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an empty trail without claiming anything about it', () => {
    // A machine where the plugin has never run. `readJsonl` returns [] for a missing file, and an
    // empty map means "no hook told us anything" — never "nothing is blocked".
    const w = watcher(() => ({ decisions: [], activity: [] }));
    w.poll();
    expect(w.snapshot().size).toBe(0);
  });

  it('stops polling once disposed', () => {
    const read = vi.fn(() => ({ decisions: [], activity: [] }));
    const w = new HookActivityWatcher(() => { }, 1, read, () => T0);
    w.start();
    const afterStart = read.mock.calls.length;
    w.dispose();
    return new Promise<void>(resolve => setTimeout(() => {
      expect(read.mock.calls.length).toBe(afterStart);
      resolve();
    }, 20));
  });
});
