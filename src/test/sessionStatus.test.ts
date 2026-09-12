import { describe, expect, it } from 'vitest';
import {
  ABANDONED_TOOL_CALL_MS,
  API_RETRY_WINDOW_MS,
  COMPACTION_WINDOW_MS,
  PROMPT_WINDOW_MS,
  STREAMING_WINDOW_MS,
  TOOL_STALL_MS,
  UNREAD_MAX_AGE_MS,
  bobStatus,
  claudeStatusFromTail,
  isBlockedOnYou,
  isQuestionTool,
  isWorklistSignal,
  needsYou,
  pendingStatusForTool,
  resolveDisplayStatus,
  type JsonlRecord,
} from '../sessionStatus';

// Every rule the status dot depends on lives here, as a pure function, precisely so the six
// states can be pinned without a VS Code host, a transcript on disk, or a Bob database. The
// table in docs/STATUS-INDICATORS.md is the prose version of these cases — change one, change both.

const NOW = 1_800_000_000_000;

/** Classify a transcript tail whose last write was `quietMs` ago. */
function tail(records: JsonlRecord[], quietMs: number) {
  return claudeStatusFromTail(records, NOW - quietMs, NOW);
}

const userPrompt = (text = 'do the thing'): JsonlRecord => ({
  type: 'user', message: { content: [{ type: 'text', text }] },
});
const toolResultRecord = (): JsonlRecord => ({
  type: 'user', toolUseResult: { ok: true },
  message: { content: [{ type: 'tool_result', text: 'done' }] },
});
const assistantText = (text = 'here you go'): JsonlRecord => ({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
});
const assistantToolUse = (name: string): JsonlRecord => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name }] },
});

describe('question tools', () => {
  it('recognises both agents’ question tools', () => {
    expect(isQuestionTool('AskUserQuestion')).toBe(true);
    expect(isQuestionTool('ask_followup_question')).toBe(true);
    expect(isQuestionTool('Bash')).toBe(false);
    expect(isQuestionTool(undefined)).toBe(false);
  });

  it('splits a pending tool into the two states it can mean', () => {
    expect(pendingStatusForTool('AskUserQuestion')).toBe('question');
    expect(pendingStatusForTool('Bash')).toBe('approval');
  });
});

describe('claudeStatusFromTail', () => {
  it('an empty tail with no recent write is dormant', () => {
    expect(tail([], STREAMING_WINDOW_MS + 1)).toBe('dormant');
  });

  it('a fresh user prompt is working — the agent is about to start', () => {
    expect(tail([userPrompt()], 1_000)).toBe('working');
  });

  it('a user prompt nobody ever answered goes dormant, it does not pulse forever', () => {
    expect(tail([userPrompt()], PROMPT_WINDOW_MS + 1)).toBe('dormant');
  });

  it('streaming assistant text is working', () => {
    expect(tail([userPrompt(), assistantText()], 1_000)).toBe('working');
  });

  it('assistant text that stopped being written is finished', () => {
    expect(tail([userPrompt(), assistantText()], STREAMING_WINDOW_MS + 1)).toBe('finished');
  });

  it('a tool call still writing is working', () => {
    expect(tail([assistantToolUse('Bash')], 1_000)).toBe('working');
  });

  it('a tool call that went quiet is an approval prompt, not a running tool', () => {
    expect(tail([assistantToolUse('Bash')], TOOL_STALL_MS + 1)).toBe('approval');
  });

  it('an unanswered question stays a question for as long as answering it is plausible', () => {
    expect(tail([assistantToolUse('AskUserQuestion')], 1_000)).toBe('question');
    expect(tail([assistantToolUse('AskUserQuestion')], 3 * 3600_000)).toBe('question');
    expect(tail([assistantToolUse('AskUserQuestion')], ABANDONED_TOOL_CALL_MS - 1_000))
      .toBe('question');
  });

  it('a tool call silent for a day is abandoned, not blocked on you', () => {
    // The bug this pins: `approval` and `question` are the two states the worklist never ages out,
    // so a session killed mid-tool-call sat at the top of the list forever — on the strength of a
    // file that will never be written again, with no process left to answer it. Observed in a real
    // registry as a 47-hour-old `approval` no window held.
    expect(tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
    expect(tail([assistantToolUse('AskUserQuestion')], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
    expect(tail([{ type: 'tool_use', name: 'Bash' }], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
  });

  it('holds the blocked states right up to the boundary', () => {
    // The bound must not eat a prompt you left overnight; a day is the point, not an approximation.
    expect(tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS - 1_000)).toBe('approval');
  });

  it('leaves a session its blocked state when a live signal still vouches for it', () => {
    // The bound only touches what the *file* claims. A live pending approval outranks it, so a
    // genuinely blocked session in an open window keeps its amber marker at any age.
    const abandoned = tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS + 1);
    expect(resolveDisplayStatus(abandoned, {
      pending: 'approval',
      updatedAtMs: NOW - ABANDONED_TOOL_CALL_MS - 1,
      nowMs: NOW,
    })).toBe('approval');
  });

  it('a question among parallel tool calls wins — it needs typing, not a click', () => {
    const rec: JsonlRecord = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'AskUserQuestion' }],
      },
    };
    expect(tail([rec], TOOL_STALL_MS + 1)).toBe('question');
  });

  it('a returned tool result is working while fresh and dormant once abandoned', () => {
    expect(tail([assistantToolUse('Bash'), toolResultRecord()], 1_000)).toBe('working');
    expect(tail([assistantToolUse('Bash'), toolResultRecord()], TOOL_STALL_MS + 1)).toBe('dormant');
  });

  it('walks back past injected context to the real last turn', () => {
    const meta: JsonlRecord = { type: 'user', isMeta: true, message: { content: 'skill loaded' } };
    expect(tail([assistantText(), meta], STREAMING_WINDOW_MS + 1)).toBe('finished');
    expect(tail([assistantToolUse('Bash'), meta], TOOL_STALL_MS + 1)).toBe('approval');
  });

  it('an interrupt you typed ends the turn — it is not a pending tool call', () => {
    const interrupt: JsonlRecord = {
      type: 'user', message: { content: '[Request interrupted by user]' },
    };
    expect(tail([assistantToolUse('Bash'), interrupt], TOOL_STALL_MS + 1)).toBe('finished');
  });

  it('a tool result answers the call above it, so the call is not read as pending', () => {
    // The regression this pins: tool results arrive as user-type records. Skipping them reached
    // the tool_use they answered and reported a finished call as an approval prompt.
    const records = [assistantToolUse('Bash'), toolResultRecord()];
    expect(tail(records, TOOL_STALL_MS + 1)).not.toBe('approval');
  });

  it('session-end records mean finished no matter how quiet the file is', () => {
    expect(tail([assistantText(), { type: 'pr-link' }], 5 * 3600_000)).toBe('finished');
    expect(tail([assistantText(), { type: 'last-prompt' }], 5 * 3600_000)).toBe('finished');
  });

  it('ignores record types that say nothing about status', () => {
    const records: JsonlRecord[] = [
      assistantToolUse('AskUserQuestion'), { type: 'ai-title' }, { type: 'file-history-snapshot' },
    ];
    expect(tail(records, 1_000)).toBe('question');
  });
});

describe('bobStatus', () => {
  it('maps Bob’s running to working', () => {
    expect(bobStatus('running')).toBe('working');
  });

  it('maps Bob’s active — which means finished — to finished', () => {
    expect(bobStatus('active')).toBe('finished');
  });

  it('a live pending approval outranks whatever the row says', () => {
    expect(bobStatus('running', 'approval')).toBe('approval');
    expect(bobStatus('active', 'question')).toBe('question');
  });
});

describe('resolveDisplayStatus', () => {
  const base = { updatedAtMs: NOW - 1_000, nowMs: NOW };

  it('a live pending approval upgrades a session that looked busy', () => {
    expect(resolveDisplayStatus('working', { ...base, pending: 'approval' })).toBe('approval');
  });

  it('never demotes on a missing live signal — the probe only sees this window', () => {
    expect(resolveDisplayStatus('approval', base)).toBe('approval');
    expect(resolveDisplayStatus('question', base)).toBe('question');
  });

  it('finished becomes seen once you have opened it since it last changed', () => {
    expect(resolveDisplayStatus('finished', { ...base, lastViewedMs: NOW })).toBe('seen');
  });

  it('finished stays finished when your last look predates the change', () => {
    expect(resolveDisplayStatus('finished', { ...base, lastViewedMs: NOW - 60_000 })).toBe('finished');
  });

  it('an unread session older than a day stops shouting', () => {
    expect(resolveDisplayStatus('finished', { updatedAtMs: NOW - UNREAD_MAX_AGE_MS - 1, nowMs: NOW }))
      .toBe('dormant');
  });

  it('leaves the other states alone', () => {
    expect(resolveDisplayStatus('working', { ...base, lastViewedMs: NOW })).toBe('working');
    expect(resolveDisplayStatus('dormant', { ...base, lastViewedMs: NOW })).toBe('dormant');
  });
});

describe('API errors', () => {
  // A rate limit, an overload, a DNS failure. Claude retries silently, writing nothing until the
  // retry lands — so the transcript looks exactly like a session sitting on a prompt. Reporting that
  // as `approval` was a false claim in the one state the worklist never ages out.

  const apiError = (text = 'API Error: 429 rate limit'): JsonlRecord => ({
    type: 'assistant', isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  });

  it('is working while a retry could still be in flight', () => {
    expect(tail([assistantToolUse('Bash'), apiError()], 1_000)).toBe('working');
  });

  it('becomes stalled, never approval, once the retry window has passed', () => {
    // The bug this fixes: nobody is being asked anything, so amber would send you looking for a
    // prompt that does not exist and cannot be cleared.
    expect(tail([assistantToolUse('Bash'), apiError()], API_RETRY_WINDOW_MS + 1)).toBe('stalled');
  });

  it('outranks the tool call it interrupted', () => {
    // Checked before the tool-call branch on purpose. Otherwise the walk skips the synthetic record,
    // reaches the call underneath, and reports a call the API never answered as blocked on you.
    expect(tail([assistantToolUse('Bash'), apiError()], TOOL_STALL_MS + 1)).not.toBe('approval');
  });

  it('is recognised from the text alone when the flag is absent', () => {
    // Older transcripts may not carry `isApiErrorMessage`. A missed API error costs a false
    // `approval`, so the detector errs toward recognising one.
    const bare: JsonlRecord = {
      type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: overloaded' }] },
    };
    expect(tail([bare], API_RETRY_WINDOW_MS + 1)).toBe('stalled');
  });

  it('does not mistake ordinary prose that mentions an API error', () => {
    // Assistant text *about* an API error is a finished answer, not an outage. Only text that begins
    // with the marker counts.
    const prose = assistantText('The API Error you saw earlier was a rate limit.');
    expect(tail([prose], STREAMING_WINDOW_MS + 1)).toBe('finished');
  });
});

describe('compaction', () => {
  // Compaction rewrites the context and resumes on its own, writing nothing while it runs. Left
  // unrecognised it fell through to "nothing conclusive" and went dormant after 30 seconds, hiding a
  // session that was about to start writing again.

  it('is working while the compaction could still be running', () => {
    expect(tail([{ type: 'compact-summary' } as JsonlRecord], 1_000)).toBe('working');
  });

  it('becomes stalled if it never comes back', () => {
    expect(tail([{ isCompactSummary: true } as JsonlRecord], COMPACTION_WINDOW_MS + 1))
      .toBe('stalled');
  });
});

describe('the hook state', () => {
  const base = { updatedAtMs: NOW, nowMs: NOW };

  it('replaces the 45-second inference with what the hooks saw', () => {
    // The point of the whole feature: `working` inferred from a moving file, upgraded to the prompt
    // the plugin actually observed open inside the session.
    expect(resolveDisplayStatus('working', { ...base, hookState: { pending: 'approval' } }))
      .toBe('approval');
    expect(resolveDisplayStatus('working', { ...base, hookState: { pending: 'question' } }))
      .toBe('question');
  });

  it('lets a live host read outrank the trail', () => {
    // The host is looking at the running process; the trail is a file written a moment ago.
    expect(resolveDisplayStatus('working', {
      ...base, pending: 'question', hookState: { pending: 'approval' },
    })).toBe('question');
  });

  it('drops a zombie approval as soon as the session is known to have ended', () => {
    // Previously this waited out ABANDONED_TOOL_CALL_MS — a full day of a dead session sitting at the
    // top of the worklist with nothing able to clear it.
    expect(resolveDisplayStatus('approval', { ...base, hookState: { settled: true } }))
      .toBe('dormant');
  });

  it('still splits finished by whether you have read it after the session ended', () => {
    // `settled` is about liveness; finished vs seen is about reading. An ended session whose result
    // you have not opened is still a result you have not opened.
    expect(resolveDisplayStatus('finished', { ...base, hookState: { settled: true } }))
      .toBe('finished');
    expect(resolveDisplayStatus('finished', {
      ...base, hookState: { settled: true }, lastViewedMs: NOW,
    })).toBe('seen');
  });

  it('changes nothing for a session that runs no hooks', () => {
    // The common case. Silence from the trail means the plugin is not installed there.
    expect(resolveDisplayStatus('working', base)).toBe('working');
    expect(resolveDisplayStatus('approval', base)).toBe('approval');
  });
});

describe('status predicates', () => {
  it('blocked-on-you is exactly the two states your input unblocks', () => {
    expect(isBlockedOnYou('approval')).toBe(true);
    expect(isBlockedOnYou('question')).toBe(true);
    expect(isBlockedOnYou('finished')).toBe(false);
    expect(isBlockedOnYou('working')).toBe(false);
    // Blocked on the API, not on you: there is nothing to click. Marking it true would exempt it
    // from the worklist's age bound and recreate the zombie row this release removes.
    expect(isBlockedOnYou('stalled')).toBe(false);
  });

  it('does not ask for you when a session is stalled', () => {
    expect(needsYou('stalled')).toBe(false);
  });

  it('keeps a stalled session in the worklist — it is live work that went wrong', () => {
    expect(isWorklistSignal('stalled')).toBe(true);
  });

  it('needs-you adds the unread result — the third reason to click', () => {
    expect(needsYou('finished')).toBe(true);
    expect(needsYou('seen')).toBe(false);
    expect(needsYou('dormant')).toBe(false);
  });

  it('the worklist keeps live states, never the quiet ones', () => {
    expect(isWorklistSignal('working')).toBe(true);
    expect(isWorklistSignal('approval')).toBe(true);
    expect(isWorklistSignal('question')).toBe(true);
    expect(isWorklistSignal('finished')).toBe(false);
    expect(isWorklistSignal('seen')).toBe(false);
    expect(isWorklistSignal('dormant')).toBe(false);
  });
});
