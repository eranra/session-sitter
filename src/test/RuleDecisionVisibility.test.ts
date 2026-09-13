import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// AutoResponder pulls in modules that import 'vscode' at load.
vi.mock('vscode', () => ({ window: { createOutputChannel: vi.fn() }, extensions: { getExtension: vi.fn() } }));

import { AutoResponder } from '../AutoResponder';
import { recordToItem } from '../SupervisionActivity';
import { resolveStateDir } from '../supervisionPaths';
import type { AutoRespondRule, BobSender } from '../agents/BobSender';
import type { BobApprover, PendingApproval } from '../agents/BobApprover';
import type { ClaudeSession } from '../SessionManager';
import type { MessagingChannel, SendResult } from '../supervisor/messaging';
import { RuleDecisionRecorder, withSessionIdentity } from '../supervisor/ruleDecisions';
import { localHostName } from '../supervisor/sessionIdentity';
import { ensureDirs, recordsDir, type SupervisorConfig } from '../supervisor/config';
import { StateStore } from '../supervisor/store';
import type { SupervisionRecord } from '../supervisor/models';

/**
 * The whole reporting chain a DETERMINISTIC decision travels, end to end, on a DEFAULT install:
 *
 *   pending approval → AutoResponder rule → RuleDecisionRecorder → record on disk
 *                                                                → human channel
 *   record on disk → SupervisionActivity.recordToItem → a row in the panel's activity feed
 *
 * The regression this guards: every one of those destinations used to be gated on the user
 * setting `sessionSitter.supervisorStateDir`. Auto-respond rules need no supervisor and no
 * settings, so with the setting unset (the default) Session Sitter auto-approved the user's tool
 * prompts and reported nothing anywhere. The state dir now always resolves, so the chain runs
 * unconfigured.
 */

class FakeSender implements BobSender {
  async isAvailable() { return true; }
  async send() { /* not used here */ }
}

class FakeApprover implements BobApprover {
  public pending: PendingApproval[] = [];
  public calls: Array<{ requestId: string; payload: Record<string, unknown> }> = [];
  async listAllPending() { return this.pending; }
  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> {
    this.calls.push({ requestId, payload });
    return 'ok';
  }
}

class FakeChannel implements MessagingChannel {
  public sent: Array<{ text: string; interactive: boolean }> = [];
  async send(_r: SupervisionRecord, text: string, interactive = true): Promise<SendResult> {
    this.sent.push({ text, interactive });
    return { messageId: 'm1', sentAt: '2026-08-31T00:00:00Z' };
  }
  async pollResponses() { return []; }
}

function bobSession(id: string): ClaudeSession {
  return {
    sessionId: id, projectName: 'p', projectPath: '/p', title: 't',
    updatedAt: new Date(), status: 'working', source: 'bob',
  };
}

function managerWith(sessions: ClaudeSession[]) {
  return {
    onDidChangeSessions: () => ({ dispose() { /* noop */ } }),
    getSessions: () => sessions,
    getRecentExchanges: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Bob's pending prompt for `use bash to answer what is the time now` → `execute_command: date`. */
function datePending(): PendingApproval {
  return {
    requestId: 'r1', toolName: 'execute_command', argsText: '{"command":"date"}',
    permission: 'execute', hasCommandUse: true, taskId: 's',
  };
}

describe('a deterministic rule decision is visible with NO configuration', () => {
  let globalStorage: string;

  beforeEach(() => { globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'sitter-storage-')); });
  afterEach(() => { fs.rmSync(globalStorage, { recursive: true, force: true }); });

  /** The extension's wiring, with `supervisorStateDir` deliberately unset. */
  function wire(notifyRuleDecisions = true) {
    const state = resolveStateDir('', globalStorage, dir => fs.mkdirSync(dir, { recursive: true }));
    const config = { stateDir: state.dir, notifyRuleDecisions } as unknown as SupervisorConfig;
    ensureDirs(config);
    const channel = new FakeChannel();
    const recorder = new RuleDecisionRecorder({
      store: new StateStore(recordsDir(config)), channel, config,
    });
    const approver = new FakeApprover();
    approver.pending = [datePending()];
    // The user's real rule: approve every Bob tool prompt for the rest of the task.
    const rules: AutoRespondRule[] = [{ source: 'bob', toolPattern: '*', decision: 'approveForTask' }];
    // Reporting is fire-and-forget in the extension (it must never delay an approval reaching a
    // blocked agent), so the test keeps the promises and awaits them instead of racing them.
    const reports: Array<Promise<unknown>> = [];
    const sessions = [bobSession('s')];
    const responder = new AutoResponder(
      managerWith(sessions), new FakeSender(), () => rules, () => { /* noop */ },
      approver, undefined, undefined, undefined, undefined, undefined, undefined,
      // Exactly what extension.ts does: name the session the decision landed in before reporting.
      (d) => {
        const session = sessions.find(x => x.sessionId === d.sessionId);
        reports.push(recorder.report(withSessionIdentity(d, session)));
      },
    );
    /** Sweep, then wait for the reporting the sweep kicked off. */
    const sweepAndSettle = async (): Promise<void> => {
      await responder.sweepApprovals();
      await Promise.all(reports);
    };
    return { state, config, channel, approver, sweepAndSettle };
  }

  it('records the auto-approval under the defaulted state dir and shows it in the activity feed',
    async () => {
      const { config, approver, sweepAndSettle } = wire();
      await sweepAndSettle();
      // The approval really reached the agent (that is what makes it worth reporting).
      expect(approver.calls).toEqual([{
        requestId: 'r1',
        payload: { allowOnce: true, groupApproved: true, alwaysApproveCommand: true },
      }]);

      const dir = recordsDir(config);
      const files = fs.readdirSync(dir).filter(f => f.startsWith('req-'));
      expect(files).toHaveLength(1);

      const item = recordToItem(fs.readFileSync(path.join(dir, files[0]), 'utf8'), Date.now());
      expect(item?.decidedBy).toBe('rule');
      expect(item?.light).toBe('green');
      expect(item?.state).toBe('rule_applied');
      expect(item?.ruleLabel).toBe("'*' → approveForTask");
      expect(item?.summary).toContain('execute_command');
      expect(item?.summary).toContain('date');
      // Which session, and on which machine — without these the row names only a task id.
      expect(item?.sessionName).toBe('t');
      expect(item?.host).toBe(localHostName());
    });

  it('sends it to the human channel as a one-way update', async () => {
    const { channel, sweepAndSettle } = wire();
    await sweepAndSettle();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].interactive).toBe(false); // never a decision card — it is already done
    expect(channel.sent[0].text).toContain('auto-approved');
    expect(channel.sent[0].text).toContain('execute_command');
  });

  it('still records it when notifications are switched off', async () => {
    const { config, channel, sweepAndSettle } = wire(false);
    await sweepAndSettle();
    expect(channel.sent).toHaveLength(0);
    expect(fs.readdirSync(recordsDir(config)).filter(f => f.startsWith('req-'))).toHaveLength(1);
  });
});
