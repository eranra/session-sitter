import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionManager } from './SessionManager';
import { SessionSitterViewProvider } from './SessionSitterViewProvider';
import { InspectorBobSender, type AutoRespondRule } from './agents/BobSender';
import { InspectorBobApprover, type PendingApproval } from './agents/BobApprover';
import { AutoResponder } from './AutoResponder';
import { PendingWatcher } from './PendingWatcher';
import { HookActivityWatcher } from './HookActivityWatcher';
import {
  dumpClaudeManagerShape,
  dumpClaudeSendApprovalShape,
  getOpenClaudeSessionIds,
} from './agents/ClaudeInspector';
import {
  captureClaudeAnswer,
  captureClaudeQuestion,
  dumpBobQuestionShape,
  dumpBobQuestionShapeFull,
  dumpClaudeQuestionShape,
  installClaudeAnswerHook,
  installClaudeQuestionHook,
} from './agents/QuestionProbe';
import { InspectorClaudeSender, dumpClaudeTargeting } from './agents/ClaudeSender';
import { InspectorClaudeApprover } from './agents/ClaudeApprover';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';
import { SessionExporter } from './SessionExporter';
import { SupervisorOutbox } from './SupervisorOutbox';
import { SupervisionService } from './SupervisionService';
import { resolveStateDir, resolveWorkspaceRoot } from './supervisionPaths';
import { supervisorConfigFromSettings, userValue } from './supervisorSettings';
import { layeredSettingsReader } from './settingsBridge';
import { ensureDirs, recordsDir, type SupervisorConfig } from './supervisor/config';
import { buildChannel } from './supervisor/factory';
import type { MessagingChannel } from './supervisor/messaging';
import {
  RuleDecisionRecorder,
  withSessionIdentity,
  type RuleDecision,
} from './supervisor/ruleDecisions';
import { StateStore } from './supervisor/store';
import { buildCard, buildQuestionCard, defaultApi } from './supervisor/telegram';
import { SupervisionState } from './supervisor/models';
import { remoteControlConfigFrom, startupBlocker, type SettingsReader } from './telegram/config';
import { ForumApi } from './telegram/forum';
import { VsCodeSessionLauncher } from './telegram/launcher';
import { RemoteControlService } from './telegram/RemoteControlService';
import { TopicStore } from './telegram/topics';
import { TopicRoutedChannel } from './telegram/topicRoutedChannel';
import { UpdateQueue } from './telegram/updateRouter';

export function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager(context);

  // The state directory holds every supervision record, and it is what the panel's activity feed
  // reads. It ALWAYS resolves — falling back to this extension's own global storage — because
  // deterministic `autoRespond` decisions are recorded there and they must never be invisible.
  // `state.explicit` (the user actually set `supervisorStateDir`) is what still gates the AI
  // supervisor, which shells out to a classifier CLI and therefore stays opt-in.
  const supervisionCfg = () => vscode.workspace.getConfiguration('sessionSitter');
  const state = resolveStateDir(
    supervisionCfg().get<string>('supervisorStateDir', ''), context.globalStorageUri.fsPath);
  const stateDir = state.dir;
  // Create it up front: the file log and the activity feed both point inside it, and a defaulted
  // global-storage path does not exist on a fresh install.
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* best-effort */ }

  // Shared output channel for logging. Also mirror to a durable file under the state dir: in a
  // multi-window (or WSL) setup the in-memory Output channel is per-extension-host and easy to
  // read from the wrong window, so a single on-disk log is the reliable record of what each
  // window's sweep/handoff actually did. Best-effort — a failed append must never break logging.
  const output = vscode.window.createOutputChannel('Session Sitter');
  context.subscriptions.push(output);
  const logFile = path.join(stateDir, 'session-sitter.log');
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] [pid:${process.pid}] ${msg}`;
    output.appendLine(line);
    try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* best-effort */ }
  };
  log(`Session Sitter activated — build v${BUILD_VERSION} @ ${BUILD_TIME}`);
  log(`state dir: ${stateDir}${state.explicit ? '' : ' (default — set sessionSitter.supervisorStateDir to move it)'}`);

  const sender = new InspectorBobSender(log);
  const approver = new InspectorBobApprover(log);
  const claudeSender = new InspectorClaudeSender(log);
  const claudeApprover = new InspectorClaudeApprover(log);

  // Which Bob tasks are sitting on a prompt right now. The panel reads this to mark a row as
  // blocked on you rather than busy — see PendingWatcher for why Claude is not in it.
  const pendingWatcher = new PendingWatcher(approver, log);

  // What our own hooks saw inside each Claude session — a prompt opened, a turn ended, the session
  // closed. This is the Claude-shaped counterpart to `pendingWatcher` above, and the only route by
  // which a Claude approval reaches a row without waiting out the transcript's 45-second inference.
  const hookActivityWatcher = new HookActivityWatcher(log);

  const provider = new SessionSitterViewProvider(
    context.extensionUri, sessionManager, log, stateDir,
    // Global, not workspace: the same session list appears in every window, so "I have read this"
    // must mean the same thing in all of them.
    context.globalState,
    () => pendingWatcher.snapshot(),
    () => hookActivityWatcher.snapshot());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionSitterViewProvider.viewType, provider),
  );

  // Repaint as soon as a prompt appears or is answered, rather than waiting for the next scan.
  pendingWatcher.setOnChange(() => provider.refresh());
  pendingWatcher.start();
  context.subscriptions.push({ dispose: () => pendingWatcher.dispose() });

  hookActivityWatcher.setOnChange(() => provider.refresh());
  hookActivityWatcher.start();
  context.subscriptions.push({ dispose: () => hookActivityWatcher.dispose() });

  // ── Commands ──────────────────────────────────────────────────────────────

  const openJson = async (header: string, body: string) => {
    const doc = await vscode.workspace.openTextDocument({ content: header + body, language: 'json' });
    void vscode.window.showTextDocument(doc);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.refresh', () => {
      void vscode.window.showInformationMessage('Sessions update automatically.');
    }),
    vscode.commands.registerCommand('sessionSitter.openSettings', () => {
      // Everything Session Sitter needs is a setting now, so this is the single entry point.
      // `@ext:<id>` filters the Settings UI to this extension; the id comes from the manifest so
      // it cannot drift from the published one.
      void vscode.commands.executeCommand(
        'workbench.action.openSettings', `@ext:${context.extension.id}`);
    }),
    vscode.commands.registerCommand('sessionSitter.newSession', () => {
      // Open a fresh conversation in the current window's editor. We avoid
      // `claude-vscode.newConversation` — it only notifies already-open Claude panels and does
      // nothing when none is open. `primaryEditor.open` with no sessionId creates a new panel.
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    }),
  );

  // Manual test: send a message into the most-recently-active EXISTING Bob session.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testBobSend', async () => {
      const target = mostRecent(sessionManager, 'bob');
      if (!target) { void vscode.window.showWarningMessage('No Bob sessions found.'); return; }
      if (!(await sender.isAvailable())) {
        void vscode.window.showErrorMessage('Bob API not available.');
        return;
      }
      await sender.send(target.sessionId, 'Hello World — test send to existing session');
      void vscode.window.showInformationMessage(`Sent test message to: ${target.title}`);
    }),
  );

  // Manual test: inject a message into the running Claude session (v1 single-channel targeting).
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testClaudeSend', async () => {
      const target = mostRecent(sessionManager, 'claude');
      if (!target) { void vscode.window.showWarningMessage('No Claude sessions found.'); return; }
      if (!(await claudeSender.isAvailable())) {
        void vscode.window.showErrorMessage('Claude extension not available.');
        return;
      }
      const result = await claudeSender.inject('Hello from Session Sitter — test Claude send');
      const msg = `Claude send result: ${result} (target: ${target.title})`;
      if (result === 'ok') { void vscode.window.showInformationMessage(msg); }
      else { void vscode.window.showWarningMessage(msg); }
    }),
  );

  // Diagnostic: install the metadata hook and list Claude's pending tool-permission prompts.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.testClaudeListApprovals', async () => {
      const hook = await claudeApprover.installHook();
      const pending = await claudeApprover.listAllPending();
      const summary = pending.length
        ? pending.map(p => `${p.toolName}(${p.argsText.slice(0, 40)})`).join(', ')
        : '(none — trigger a permission prompt, then run again)';
      void vscode.window.showInformationMessage(
        `Claude pending approvals: ${pending.length} — ${summary} [${hook}]`);
    }),
  );

  // ── Read-only internals probes (debugging the agent bridges) ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.probeClaudeOpen', async () => {
      const state = await getOpenClaudeSessionIds(log);
      const shape = await dumpClaudeManagerShape(log);
      await openJson(
        `// Claude open panels: ${state.open.length} [${state.open.join(', ')}] · `
        + `active=${state.active ?? '(none)'} · ${state.diag ?? ''}\n`
        + '// Manager field shape (find which field holds your open session id):\n',
        shape);
    }),
    vscode.commands.registerCommand('sessionSitter.probeClaudeInternals', async () => {
      await openJson(
        '// Claude send + approval shape probe (read-only). Find:\n'
        + '//  - a message-inject method on a session state or one of its children\n'
        + '//  - where a pending permission request + its resolver live\n',
        await dumpClaudeSendApprovalShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeClaudeTargeting', async () => {
      await openJson(
        '// Where a Telegram message to each Claude session would land (read-only — nothing is\n'
        + '// sent). Check after a Claude Code update:\n'
        + '//  - verdict "would-send:owner" — the session is matched to its own tab or sidebar\n'
        + '//  - verdict "refused:ambiguous:N" with hasPanelTab false — Claude renamed the field\n'
        + '//    a comm stores its panel in, and targeting has fallen back to refusing\n',
        await dumpClaudeTargeting(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeBobQuestion', async () => {
      await openJson(
        '// Bob ask_followup_question shape probe (read-only). Find:\n'
        + '//  - signatureArgs: the question + options/choices INPUT schema\n'
        + '//  - requestOwnProps / approvalHandlerShape: how a selected answer resolves\n',
        await dumpBobQuestionShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeBobQuestionFull', async () => {
      await openJson(
        '// Bob FULL approval-state probe (read-only). Use when "Probe Bob Question" returns\n'
        + '// questions:[] to locate where a live question actually lives.\n',
        await dumpBobQuestionShapeFull(log));
    }),
    vscode.commands.registerCommand('sessionSitter.probeClaudeQuestion', async () => {
      await openJson(
        '// Claude AskUserQuestion shape probe (read-only). Find:\n'
        + '//  - the request type + inputs (questions/options/multiSelect)\n'
        + '//  - the deferred resolve join point + expected value shape\n',
        await dumpClaudeQuestionShape(log));
    }),
    vscode.commands.registerCommand('sessionSitter.installClaudeQuestionHook', async () => {
      const result = await installClaudeQuestionHook(log);
      void vscode.window.showInformationMessage(
        `Claude question hook: ${result}. Now trigger a NEW AskUserQuestion, then run `
        + '"Capture Claude Question".');
    }),
    vscode.commands.registerCommand('sessionSitter.captureClaudeQuestion', async () => {
      await openJson(
        '// Claude AskUserQuestion capture (needs the hook installed first). Find:\n'
        + '//  - outstanding[].recorded.type / .toolName / .payload = the request + input schema\n'
        + '//  - recentRecorded[] = recently-resolved requests (answer-flow confirmation)\n',
        await captureClaudeQuestion(log));
    }),
    vscode.commands.registerCommand('sessionSitter.installClaudeAnswerHook', async () => {
      const result = await installClaudeAnswerHook(log);
      void vscode.window.showInformationMessage(
        `Claude answer hook: ${result}. Now ANSWER the question, then run "Capture Claude Answer".`);
    }),
    vscode.commands.registerCommand('sessionSitter.captureClaudeAnswer', async () => {
      await openJson(
        '// Claude AskUserQuestion answer capture (needs the answer hook installed before\n'
        + '// answering). answers[].resolvedWith = the exact value passed to deferred.resolve.\n',
        await captureClaudeAnswer(log));
    }),
  );

  // ── Supervision ───────────────────────────────────────────────────────────
  // This extension is the single session reader: it exports full transcripts for the supervisor
  // and applies the supervisor's decisions back into the running agent.

  const cfg = supervisionCfg();
  const autoSupervise = cfg.get<boolean>('autoSupervise', true);
  // Workspace root: an explicit setting, else derived from an EXPLICIT state dir (<root>/.state or
  // <root>/supervisor/.state), else the first workspace folder. A defaulted state dir is never
  // used — its parent is global storage, not a repo.
  const workspaceRoot = resolveWorkspaceRoot(
    cfg.get<string>('supervisorRepoPath', ''), state, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  // Everything the supervisor needs now comes from `sessionSitter.*` settings (editable in the
  // Settings UI). `.env` / process env remain a legacy fallback for values left unset, so an
  // existing env-based install keeps working — but no env var is required any more.
  const supervisorConfig: SupervisorConfig = (() => {
    const base = supervisorConfigFromSettings({
      workspaceRoot: workspaceRoot || undefined,
      stateDir: stateDir || undefined,
      envFiles: workspaceRoot ? [path.join(workspaceRoot, '.supervisor.env')] : [],
    });
    // The corpus repo is the knowledge source, and there is deliberately no fallback to the
    // workspace. The workspace is the tree the supervised agent can write, so defaulting policy
    // to it let an agent author the clauses that govern it — highest-precedence tier included.
    // With `sessionSitter.dataRepoPath` unset, supervision runs without BDI (see
    // `Orchestrator.loadBundle`) rather than trusting a writable source: the same
    // never-substitute-a-guess rule the slug routing already follows.
    if (!base.knowledgeLocalRepo && !base.knowledgeRepo) {
      log('[knowledge] no knowledge source configured (sessionSitter.dataRepoPath is empty); '
        + 'supervision will classify without BDI knowledge. The workspace is NOT used as a '
        + 'fallback, because the supervised agent can write to it.');
    }
    return base;
  })();

  // Remote-control settings are read here because they change how the messaging channel below is
  // built: when the remote interface is on it owns the single read on the bot token, and supervision
  // is handed its updates instead of polling for them.
  //
  // The adapter spells each setting name out in a direct read rather than forwarding the caller's
  // string. That is the form `ci/check-settings.mjs` recognises, so these keys count as read
  // and cannot silently drift from their `package.json` declarations.
  //
  // Layered over the environment, the same precedence `applySupervisorSettings` applies: a setting the
  // user actually set wins, otherwise the variable, otherwise the declared default. That is what lets
  // one machine be configured once and read the same way by a window and by `session-sitter daemon`.
  //
  // `inspect()` rather than `get()` is load-bearing here. `get()` returns the manifest default for an
  // unset setting, so an env layer beneath it would be unreachable for every setting that has a
  // default — which is all four of these.
  // Each key stays a *literal* in a `userValue` call. That is the form `ci/check-settings.mjs`
  // recognises, so these four still count as read and cannot silently drift from their `package.json`
  // declarations — passing `key` straight through would have been shorter and would have made all four
  // look unread, which is the drift the guard exists to catch.
  const explicitTelegram = {
    getBoolean: (key: string): boolean | undefined => {
      if (key === 'telegram.remoteControl') {
        return userValue<boolean>(cfg, 'telegram.remoteControl');
      }
      if (key === 'telegram.fullMessages') {
        return userValue<boolean>(cfg, 'telegram.fullMessages');
      }
      return undefined;
    },
    getStringArray: (key: string): string[] | undefined => (key === 'telegram.allowedUserIds'
      ? userValue<string[]>(cfg, 'telegram.allowedUserIds')
      : undefined),
    getNumber: (key: string): number | undefined => (key === 'telegram.maxMessageParts'
      ? userValue<number>(cfg, 'telegram.maxMessageParts')
      : undefined),
  };
  const remoteControlSettings: SettingsReader = layeredSettingsReader(explicitTelegram);
  const remoteControlConfig = remoteControlConfigFrom(remoteControlSettings, supervisorConfig);
  const remoteControlActive = remoteControlConfig.enabled && !!remoteControlConfig.botToken
    && !!remoteControlConfig.chatId && remoteControlConfig.allowedUserIds.length > 0;

  // A bot token has ONE update stream and reading it is destructive. So when the remote interface is
  // active it does the reading, and supervision drains this queue instead of calling `getUpdates`.
  // Two pollers on one token would each see a random half of the replies — the exact defect the
  // remote control's reader lease exists to prevent.
  const supervisionUpdates = new UpdateQueue();

  // ONE messaging channel per window, shared by the supervisor and the deterministic-rule
  // reporter: two Telegram consumers on the same bot would fight over `getUpdates`.
  // Built unconditionally: `autoRespond` rules act on the user's session with no supervisor and no
  // configuration at all, so their record and their notification can never be conditional on a
  // setting. The state dir always resolves, so there is always somewhere to write them.
  ensureDirs(supervisorConfig);
  const baseChannel: MessagingChannel = buildChannel(
    supervisorConfig, log,
    remoteControlActive ? () => supervisionUpdates.drain() : undefined);
  if (remoteControlActive) {
    log('supervision: inbound replies arrive via the Telegram remote control, which owns the single '
      + 'read on this bot token.');
  }

  // With the remote interface on, a decision about a session posts into THAT session's topic rather
  // than a single shared feed — beside the conversation it is about, which is where it is answered
  // from. Falls back to the plain channel when the session has no topic yet.
  const remoteTopics = new TopicStore();
  const channel: MessagingChannel = remoteControlActive
    ? new TopicRoutedChannel({
      inner: baseChannel,
      topics: remoteTopics,
      forum: new ForumApi(
        defaultApi(remoteControlConfig.botToken), remoteControlConfig.chatId, log),
      buildCard: (record, notification, interactive) => (
        interactive && record.state === SupervisionState.ORANGE_AWAITING_QUESTION
          && record.question_spec
          ? buildQuestionCard(record)
          : buildCard(record, notification, {
            interactive,
            minutesLeft: interactive ? supervisorConfig.orangeResponseTimeoutMinutes : null,
          })
      ),
      log,
    })
    : baseChannel;
  const ruleRecorder = new RuleDecisionRecorder({
    store: new StateStore(recordsDir(supervisorConfig)),
    channel,
    config: supervisorConfig,
    log,
  });
  log(
    `rule decisions: recording to ${recordsDir(supervisorConfig)}`
    + ` — notify=${supervisorConfig.notifyRuleDecisions} via ${supervisorConfig.messagingChannel}`,
  );
  // The panel names the channel on a card that is waiting for you, so it has to know which one
  // won: the setting layers over `.env`, and only this config has the answer.
  provider.setMessagingChannel(supervisorConfig.messagingChannel);
  if (supervisorConfig.notifyRuleDecisions && supervisorConfig.messagingChannel !== 'telegram') {
    log('rule decisions: no human channel configured, so they appear in the panel only. Set '
      + 'sessionSitter.supervisor.messagingChannel to "telegram" plus '
      + 'sessionSitter.supervisor.telegramBotToken and .telegramChatId to also get them on Telegram.');
  }

  // The outbox applies supervisor decisions: an approval-channel delivery goes through the
  // agent's approval emitter (the only channel that reaches a prompt-blocked task); a
  // message-channel delivery is injected as a labeled chat message into an idle task.
  // Gated on the EXPLICIT setting, like the supervisor it serves: a defaulted state dir turns on
  // reporting, never the AI supervision loop.
  let outbox: SupervisorOutbox | undefined;
  if (state.explicit) {
    const resolveActiveSession = (): string | undefined => mostRecent(sessionManager, 'bob')?.sessionId;
    outbox = new SupervisorOutbox(
      path.join(stateDir, 'outbox'), sender, log, approver, resolveActiveSession,
      claudeSender, claudeApprover);
    outbox.start(1500); // the interval is the safety net; deliveries are also kicked directly
    context.subscriptions.push({ dispose: () => outbox?.dispose() });
  }

  // The supervisor itself runs in-process (no interpreter, no child process). Deliveries kick
  // the outbox immediately so an approval reaches a blocked agent in milliseconds.
  let supervision: SupervisionService | undefined;
  if (autoSupervise && state.explicit && workspaceRoot) {
    supervision = new SupervisionService({
      enabled: true,
      supervisorConfig,
      user: cfg.get<string>('knowledge.user', ''),
      project: cfg.get<string>('knowledge.project', ''),
      team: cfg.get<string>('knowledge.team', ''),
      bobDbPath: sessionManager.getBobDbPath(),
    }, log, () => { void outbox?.poll(); }, channel);
    supervision.start();
    context.subscriptions.push({ dispose: () => supervision?.dispose() });
  } else if (autoSupervise) {
    log('supervision not started: set sessionSitter.supervisorStateDir '
      + '(and sessionSitter.supervisorRepoPath if it cannot be derived from it).');
  }

  // ── Telegram remote control ───────────────────────────────────────────────
  //
  // Runs in EVERY window, because responsibility for a session belongs to the window that owns it.
  // Only one window per machine READS Telegram; that is settled by a lease inside the service.
  // Writing is unleased — each window posts its own sessions' messages. Default off.
  let remoteControl: RemoteControlService | undefined;
  if (remoteControlActive) {
    remoteControl = new RemoteControlService({
      config: remoteControlConfig,
      sessionManager,
      // The panel is the single source of truth for which sessions are active, so Telegram shows
      // the same worklist the sidebar does rather than every session the machine has ever seen.
      partition: () => provider.sessionPartition(),
      bobSender: sender,
      claudeSender,
      launcher: new VsCodeSessionLauncher(
        log,
        (sessionId, source) => provider.focusSession(sessionId, source),
        {
          // The first message is what turns a freshly opened panel into a session with a transcript,
          // which is what makes it appear in the worklist and gives its topic something to mirror.
          sendToSession: (sessionId, text) => claudeSender.sendToSession(sessionId, text),
          host: os.hostname().split('.')[0],
        }),
      api: defaultApi(remoteControlConfig.botToken),
      log,
      // Supervision no longer polls for itself, so its updates are forwarded here.
      supervisionSink: update => supervisionUpdates.push(update),
      supervisionMessageIds: async () => {
        const store = new StateStore(recordsDir(supervisorConfig));
        const awaiting = await store.byState(
          SupervisionState.ORANGE_AWAITING_USER, SupervisionState.ORANGE_AWAITING_QUESTION);
        return new Set(
          awaiting.map(r => String(r.notification_id ?? '')).filter(id => id.length > 0));
      },
    });
    remoteControl.start();
    context.subscriptions.push({ dispose: () => remoteControl?.dispose() });
  } else {
    const blocker = startupBlocker(remoteControlConfig);
    if (blocker !== null) { log(`remote control: not started — ${blocker}`); }
  }

  // Export the most-recent Claude session's transcript (with its live pending approval) for the
  // supervisor, then return its id. Undefined when no Claude session / file path resolves
  // (v1: single-session correlation, because a Claude approval carries a channelId, not a
  // session id).
  const exportClaudeForSupervision = async (p: PendingApproval): Promise<string | undefined> => {
    if (!state.explicit) { log('supervision(claude): no stateDir configured'); return undefined; }
    const recent = mostRecent(sessionManager, 'claude');
    if (!recent) {
      log(`supervision(claude): 0 claude sessions (total=${sessionManager.getSessions().length})`);
      return undefined;
    }
    const filePath = sessionManager.getSessionFilePath(recent.sessionId);
    if (!filePath) {
      log(`supervision(claude): no filePath for ${recent.sessionId}`);
      return undefined;
    }
    const exporter = new SessionExporter(sessionManager.getBobDbPath());
    await exporter.exportClaude(
      {
        sessionId: recent.sessionId, projectName: recent.projectName,
        projectPath: recent.projectPath, status: recent.status, title: recent.title,
      },
      filePath, path.join(stateDir, 'history'), p,
    );
    log(`supervision(claude): exported ${recent.sessionId} for ${p.toolName} req=${p.requestId}`);
    return recent.sessionId;
  };

  // Auto-respond: watch sessions and send configured text replies on a pattern match, resolve
  // pending tool-approval prompts per configured approval rules, and hand any UNHANDLED pending
  // prompt to the supervisor (export + classify).
  const getRules = (): AutoRespondRule[] =>
    vscode.workspace.getConfiguration('sessionSitter')
      .get<AutoRespondRule[]>('autoRespond', []);

  // Every deterministic rule decision is recorded and reported, so the panel and Telegram show
  // ALL of Session Sitter's interventions — not only the ones the supervisor AI took.
  // A Claude pending approval carries a channelId as its `taskId`, so relabel it with the
  // session the decision actually landed in (same single-session correlation the export uses).
  // The session's name and machine are attached here rather than at each call site: this is the
  // one place that has both the (possibly relabelled) session id and the session list to look it
  // up in. Without them a rule card names nothing but a UUID.
  const onRuleDecision = (d: RuleDecision): void => {
    const sessionId = d.source === 'claude'
      ? (mostRecent(sessionManager, 'claude')?.sessionId ?? d.sessionId)
      : d.sessionId;
    const session = sessionManager.getSessions().find(s => s.sessionId === sessionId);
    void ruleRecorder.report(withSessionIdentity({ ...d, sessionId }, session));
  };

  const autoResponder = new AutoResponder(
    sessionManager, sender, getRules, log, approver,
    supervision ? (p) => { void supervision!.maybeTrigger(p); } : undefined,
    supervision ? (ids) => supervision!.prune(ids) : undefined,
    claudeSender,
    claudeApprover,
    supervision
      ? (p) => { void supervision!.maybeTriggerClaude(p, exportClaudeForSupervision); }
      : undefined,
    supervision ? (ids) => supervision!.pruneClaude(ids) : undefined,
    onRuleDecision,
  );
  autoResponder.start();
  context.subscriptions.push({ dispose: () => autoResponder.dispose() });

  // Manual export of a Bob session's full transcript, for classifying it by hand.
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.exportSessionForSupervision', async () => {
      if (!state.explicit) {
        void vscode.window.showErrorMessage('Set sessionSitter.supervisorStateDir first.');
        return;
      }
      // The interrupt point is a LIVE pending approval in Bob's memory. Read it first and target
      // the task that owns it — a task blocked mid-prompt often isn't in getSessions() yet (its
      // title/first_message hasn't been flushed to bob.db). Fall back to the most recent Bob
      // session only when nothing is pending (idle-task / message case).
      let pending: PendingApproval[] = [];
      try {
        pending = await approver.listAllPending();
      } catch (err) {
        log(`listAllPending failed: ${String(err)}`);
      }
      log(`listAllPending → ${pending.length} pending: `
        + pending.map(p => `${p.taskId.slice(0, 12)}:${p.toolName}`).join(', '));

      let targetId: string | undefined = pending[0]?.taskId;
      let targetLabel = targetId ?? '';
      if (!targetId) {
        const recent = mostRecent(sessionManager, 'bob');
        if (!recent) {
          void vscode.window.showWarningMessage('No Bob sessions or pending approvals found.');
          return;
        }
        targetId = recent.sessionId;
        targetLabel = recent.title;
      }
      const livePending = pending.find(p => p.taskId === targetId);
      try {
        const exporter = new SessionExporter(sessionManager.getBobDbPath());
        const out = await exporter.exportBob(
          targetId, path.join(stateDir, 'history'), livePending);
        log(`exported transcript for ${targetId} -> ${out}`
          + (livePending
            ? ` (pending: ${livePending.toolName} req=${livePending.requestId})`
            : ' (no live pending)'));
        void vscode.window.showInformationMessage(
          `Exported session for supervision: ${targetLabel}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
      }
    }),
  );

  // Classify the currently-blocked session on demand (useful with autoSupervise off).
  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.superviseNow', async () => {
      if (!supervision) {
        void vscode.window.showErrorMessage(
          'Supervision is not running. Set sessionSitter.supervisorStateDir and enable '
          + 'sessionSitter.autoSupervise.');
        return;
      }
      const pending = await approver.listAllPending();
      if (pending.length === 0) {
        void vscode.window.showInformationMessage('No pending approval to supervise.');
        return;
      }
      const record = await supervision.maybeTrigger(pending[0]);
      void vscode.window.showInformationMessage(
        record ? `Supervision: ${record.state}` : 'Supervision: already handled.');
    }),
  );

  context.subscriptions.push(provider);
}

/**
 * Most recently updated **local** session for one source, or undefined.
 *
 * Peer sessions are excluded deliberately. Supervision drives agent CLIs and writes state
 * directories on the machine that owns the session, so it stays local-only — and without this
 * filter a busy peer session could be picked here in place of the local one that actually needs
 * supervising.
 */
function mostRecent(sessionManager: SessionManager, source: 'bob' | 'claude') {
  return sessionManager.getSessions()
    .filter(s => s.source === source && !s.peer)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

export function deactivate() { /* nothing to tear down beyond the disposables */ }
