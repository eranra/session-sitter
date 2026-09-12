/**
 * The hook trail reader: turning what the plugin observed inside a session into a status.
 *
 * These tests are the specification for `src/hookActivity.ts`. The thing being pinned is not really
 * the mapping — it is the *bracket*: a prompt is open until something closes it, and every case below
 * is a different way that bracket can open, close, or be left dangling.
 */

import { describe, expect, it } from 'vitest';
import {
  HOOK_IDLE_MAX_AGE_MS,
  HOOK_PENDING_MAX_AGE_MS,
  HookTrailRecord,
  applyHookState,
  hookStateForSession,
  hookStatesBySession,
} from '../hookActivity';

const T0 = Date.parse('2026-09-12T10:00:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** A `PermissionRequest` decision record, as `permissionRequest.ts` writes it. */
const decision = (
  tool: string, verdict: 'allow' | 'deny' | 'none', offsetMs = 0,
): HookTrailRecord => ({
  ts: at(offsetMs), sessionId: 's1', tool, decision: verdict,
  actor: verdict === 'none' ? 'human' : 'policy',
});

/** A `PostToolUse` record, as `postToolUse.ts` writes it. Identified by its fingerprint. */
const toolResult = (tool: string, offsetMs = 0): HookTrailRecord => ({
  ts: at(offsetMs), sessionId: 's1', tool, fingerprint: 'abc123def456', ok: true,
});

/** A `Notification` wait record, as `notification.ts` writes it. */
const wait = (waiting: string, offsetMs = 0): HookTrailRecord => ({
  ts: at(offsetMs), sessionId: 's1', waiting, message: null,
});

describe('hookStateForSession', () => {
  it('reports nothing when the session has no records', () => {
    // The common case: the plugin is not installed in that session. Saying nothing is the only
    // honest answer, and it is what leaves the transcript inference in charge.
    expect(hookStateForSession([], T0)).toEqual({});
  });

  describe('questions', () => {
    it('reads an exempt AskUserQuestion decision as a pending question', () => {
      // The earliest signal there is for a question: the hook was asked, declined to answer, and
      // recorded that it left the question with the human. It lands when the tool is called, well
      // before any notification fires.
      const state = hookStateForSession([decision('AskUserQuestion', 'none')], T0 + 1_000);
      expect(state.pending).toBe('question');
      expect(state.tool).toBe('AskUserQuestion');
    });

    it('reads an exempt ExitPlanMode decision as a pending approval', () => {
      // A plan waiting to be approved needs a yes/no rather than typing, so it is `approval` — but it
      // is unambiguously blocked on you, which is the part that decides the row.
      expect(hookStateForSession([decision('ExitPlanMode', 'none')], T0).pending).toBe('approval');
    });

    it('clears the question once the tool returns a result', () => {
      // An answered `AskUserQuestion` produces a `PostToolUse` record. That closes the bracket, and
      // it is what lets this module retract a prompt instead of waiting out a timeout.
      const state = hookStateForSession([
        decision('AskUserQuestion', 'none', 0),
        toolResult('AskUserQuestion', 2_000),
      ], T0 + 3_000);
      expect(state.pending).toBeUndefined();
    });

    it('does not treat a question as pending once it is a day old', () => {
      // The closing record can be lost — the session was killed mid-prompt. Without this bound one
      // lost record pins a row to the top of the worklist forever.
      const state = hookStateForSession(
        [decision('AskUserQuestion', 'none')], T0 + HOOK_PENDING_MAX_AGE_MS + 1,
      );
      expect(state.pending).toBeUndefined();
    });
  });

  describe('approvals', () => {
    it('reads a permission_prompt notification as a pending approval', () => {
      expect(hookStateForSession([wait('permission_prompt')], T0 + 1_000).pending).toBe('approval');
    });

    it('clears the approval when any tool then runs', () => {
      // A notification carries no tool name, so the bracket has to be closed by the next tool result
      // whatever it is. Over-holding a prompt is the worse error: it is unclearable from the UI.
      const state = hookStateForSession([
        wait('permission_prompt', 0), toolResult('Bash', 1_000),
      ], T0 + 2_000);
      expect(state.pending).toBeUndefined();
    });

    it('keeps a named prompt open when an unrelated tool completes', () => {
      // Claude runs several tools per turn. An auto-approved `Read` finishing while an `ExitPlanMode`
      // prompt sits on screen must not clear that prompt.
      const state = hookStateForSession([
        decision('ExitPlanMode', 'none', 0), toolResult('Read', 1_000),
      ], T0 + 2_000);
      expect(state.pending).toBe('approval');
    });

    it('does not report a prompt for a decision the hook answered itself', () => {
      // An allowed or denied call never reached a human, so nothing is blocked.
      expect(hookStateForSession([decision('Bash', 'allow')], T0).pending).toBeUndefined();
      expect(hookStateForSession([decision('Bash', 'deny')], T0).pending).toBeUndefined();
    });

    it('prefers the newest prompt when two open in a row', () => {
      const state = hookStateForSession([
        wait('permission_prompt', 0), decision('AskUserQuestion', 'none', 1_000),
      ], T0 + 2_000);
      expect(state.pending).toBe('question');
    });
  });

  describe('idle', () => {
    it('reports idle after an idle_prompt notification', () => {
      // `idle_prompt` fires ~60s after a turn ends with nobody typing: a real observation that the
      // agent finished and is waiting on you.
      expect(hookStateForSession([wait('idle_prompt')], T0 + 1_000).idle).toBe(true);
    });

    it('lets a prompt outrank an idle notification', () => {
      // Both can be recent. Blocked is the more urgent truth, and the one worth naming on the row.
      const state = hookStateForSession([
        wait('idle_prompt', 0), wait('permission_prompt', 1_000),
      ], T0 + 2_000);
      expect(state.pending).toBe('approval');
      expect(state.idle).toBeUndefined();
    });

    it('stops reporting idle once a tool runs again', () => {
      // The agent picked the work back up, so it is not waiting on anyone.
      const state = hookStateForSession([
        wait('idle_prompt', 0), toolResult('Bash', 1_000),
      ], T0 + 2_000);
      expect(state.idle).toBeUndefined();
    });

    it('ages an idle notification out', () => {
      const state = hookStateForSession([wait('idle_prompt')], T0 + HOOK_IDLE_MAX_AGE_MS + 1);
      expect(state.idle).toBeUndefined();
    });
  });

  describe('session end', () => {
    it('reports settled, and drops a prompt that was open', () => {
      // The terminal signal. A prompt left open by a session that has since closed is a zombie:
      // there is no process left to answer it.
      const state = hookStateForSession([
        wait('permission_prompt', 0), wait('session_end', 1_000),
      ], T0 + 2_000);
      expect(state.settled).toBe(true);
      expect(state.pending).toBeUndefined();
    });

    it('reports a prompt opened by a later session on the same id', () => {
      // A resumed session reuses its id, so records accumulate across runs. The walk is forward, so
      // the newer prompt is what stands.
      const state = hookStateForSession([
        wait('session_end', 0), wait('permission_prompt', 1_000),
      ], T0 + 2_000);
      expect(state.pending).toBe('approval');
      expect(state.settled).toBeUndefined();
    });
  });

  describe('the active tool', () => {
    it('reports the last tool that ran', () => {
      const state = hookStateForSession([
        toolResult('Read', 0), toolResult('Bash', 1_000),
      ], T0 + 2_000);
      expect(state.tool).toBe('Bash');
    });
  });
});

describe('hookStatesBySession', () => {
  it('interleaves the two files by timestamp rather than by file', () => {
    // The bracket spans both files — a prompt opens in decisions.jsonl and closes in activity.jsonl.
    // Folding them in file order would leave the prompt open forever.
    const decisions = [decision('ExitPlanMode', 'none', 0)];
    const activity = [toolResult('ExitPlanMode', 1_000)];
    const states = hookStatesBySession(decisions, activity, T0 + 2_000);
    expect(states.get('s1')?.pending).toBeUndefined();
  });

  it('keeps sessions apart', () => {
    const states = hookStatesBySession(
      [{ ...decision('AskUserQuestion', 'none'), sessionId: 'a' }],
      [{ ...toolResult('Bash'), sessionId: 'b' }],
      T0 + 1_000,
    );
    expect(states.get('a')?.pending).toBe('question');
    expect(states.get('b')?.pending).toBeUndefined();
  });

  it('ignores records with no usable session id', () => {
    // `unknown` is what the hooks write when the event carried no session id. Attaching a prompt to
    // a session literally named "unknown" would be worse than dropping it.
    const states = hookStatesBySession(
      [{ ...decision('AskUserQuestion', 'none'), sessionId: 'unknown' }], [], T0,
    );
    expect(states.size).toBe(0);
  });

  it('omits sessions it has nothing to say about', () => {
    // An empty conclusion carried in the map would be indistinguishable from a real one downstream.
    expect(hookStatesBySession([decision('Bash', 'allow')], [], T0).size).toBe(0);
  });
});

describe('applyHookState', () => {
  it('leaves the inferred status alone when there are no hook records', () => {
    // No hooks means the plugin is not installed there — never "nothing is happening".
    expect(applyHookState('working', undefined)).toBe('working');
    expect(applyHookState('approval', undefined)).toBe('approval');
  });

  it('upgrades a merely-working session to the prompt that is actually open', () => {
    // The whole point: an observation at ~6s replacing an inference at 45s.
    expect(applyHookState('working', { pending: 'approval' })).toBe('approval');
    expect(applyHookState('working', { pending: 'question' })).toBe('question');
  });

  it('drops a blocked state once the session has ended', () => {
    // Immediately, rather than after ABANDONED_TOOL_CALL_MS.
    expect(applyHookState('approval', { settled: true })).toBe('dormant');
    expect(applyHookState('question', { settled: true })).toBe('dormant');
    expect(applyHookState('stalled', { settled: true })).toBe('dormant');
  });

  it('leaves finished and seen alone when the session has ended', () => {
    // Both are still true of a session that ended, and they are about reading rather than liveness.
    expect(applyHookState('finished', { settled: true })).toBe('finished');
    expect(applyHookState('seen', { settled: true })).toBe('seen');
  });

  it('promotes working to finished when the agent is waiting on you', () => {
    expect(applyHookState('working', { idle: true })).toBe('finished');
  });

  it('never lets idle override a blocked state', () => {
    expect(applyHookState('approval', { idle: true })).toBe('approval');
  });
});
