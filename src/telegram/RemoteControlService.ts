/**
 * Telegram remote control, as it runs inside one VS Code window.
 *
 * Every window runs one of these. What a given window does depends on two independent facts:
 *
 *  - **Which sessions it owns** (`ownership.ts`) — it mirrors those into topics and applies commands
 *    aimed at them. This is the per-window responsibility the feature is built around.
 *  - **Whether it holds the reader lease** (`lease.ts`) — exactly one window per machine reads
 *    `getUpdates`, because a bot token has one destructive update stream. The reader also renders
 *    the General list and reports command results.
 *
 * Writing is not leased. Each window posts its own sessions' messages, so nothing is centralised
 * that does not have to be.
 *
 * ## The loop
 *
 * One self-scheduling pass, not a fixed interval, because `getUpdates` long-polls and overlapping
 * passes would double-consume updates — the same reason `SupervisionService` is written this way.
 * Each pass: refresh the lease, mirror owned sessions, take bus commands for owned sessions, and
 * (as reader) poll Telegram, route intents, and report results.
 *
 * ## The group shows the active worklist, and only that
 *
 * Which sessions appear is not this file's decision — it asks the panel, through `deps.partition`,
 * and mirrors the answer. That is deliberate: a fleet accumulates hundreds of past sessions, and a
 * Telegram group holding a topic for each is unreadable. Sharing one rule with the panel is also
 * what stops the two disagreeing about the same fleet, which is worse than either list being wrong,
 * because then neither can be trusted. `/history` reaches everything else.
 *
 * ## What it will not do
 *
 * It never sends a message to a session it cannot positively identify. A prompt delivered to the
 * wrong agent is worse than one not delivered, because the wrong agent acts on it. Where targeting
 * is impossible the user is told, in the topic, with the reason.
 */

import * as os from 'os';
import type { ClaudeSession, SessionManager } from '../SessionManager';
import type { MessageSender } from '../agents/BobSender';
import { readLiveWindows, type WindowEntry } from '../WindowRegistry';
import type { ApiFn } from '../supervisor/telegram';
import {
  applyCommand, commandIsMine, type SessionLauncher, type TargetedClaudeSender,
} from './applyCommand';
import {
  claimCommand, dropCommand, expiredCommands, newCommandId, postCommand, postResult,
  readPendingCommands, takeResults, leasePath, sweep, type BusCommand,
} from './bus';
import {
  effectiveMessageParts, startupBlocker, statusHoldMs, toolSampleMs, type RemoteControlConfig,
} from './config';
import { ForumApi, type ReplyMarkup } from './forum';
import { classifyUpdate, decodeCallback, encodeCallback, type Intent } from './intent';
import { ReaderLease, LEASE_RENEW_MS } from './lease';
import {
  daemonClaimantFrom, resolveOwner, resolveOwners, writeBlockedReason,
  type DaemonClaimant, type Ownership,
} from './ownership';
import { health, heartbeatPath, readHeartbeat } from '../daemonHeartbeat';
import {
  fleetSignature, planMirror, renderFleetList, renderHelp, renderHistoryList, renderTopicHeader,
  renderWho, sessionLabel, topicName, turnKey, type ListEntry,
} from './render';
import { chooseLaunchTarget, targetCaveat } from './newSession';
import { shouldRenameTopic, TopicStore, topicsToDelete, type TopicRecord } from './topics';
import { routeUpdate } from './updateRouter';

/** Seconds `getUpdates` waits before returning empty, so a tap arrives near-instantly. */
const LONG_POLL_SECONDS = 10;
/** Pause between passes when this window is not the reader (nothing to long-poll on). */
const IDLE_PASS_MS = 3_000;
/** Abandoned command and result files older than this are swept. */
const SWEEP_AFTER_MS = 10 * 60_000;
/** Sent texts remembered per session, so the mirror does not echo them back. */
const ECHO_MEMORY = 5;
/**
 * How many turns of a transcript the mirror reads each pass.
 *
 * Deeper than the panel's six, and the depth is load-bearing rather than generous. Mirroring resumes
 * from the last turn it posted, so a session that produces more turns between two passes than this
 * window holds pushes the anchor out of the window — and while `planMirror` recovers from that by
 * timestamp, a window barely larger than a pass would be doing that recovery constantly. Tool
 * activity spends this budget too, and a working agent makes far more tool calls than it speaks.
 */
const MIRROR_TAIL_TURNS = 60;

export interface RemoteControlDeps {
  config: RemoteControlConfig;
  sessionManager: SessionManager;
  /**
   * The active worklist and History, exactly as the Sessions panel computes them.
   *
   * Injected rather than derived here so both surfaces apply one rule (`sessionActivity.ts`) to one
   * set of live signals, and so the statuses shown in Telegram are the same *display* statuses the
   * panel renders — a pending approval folded in, `finished` split by whether you have read it.
   * Reading `SessionManager` directly instead would put every session that ever ran in the group.
   */
  partition: () => Promise<{ active: ClaudeSession[]; history: ClaudeSession[] }>;
  bobSender: MessageSender;
  claudeSender: TargetedClaudeSender;
  launcher: SessionLauncher;
  api: ApiFn;
  log: (msg: string) => void;
  pid?: number;
  hostname?: string;
  homedir?: string;
  now?: () => number;
  /**
   * Where to put updates that belong to supervision rather than to this feature.
   *
   * This feature owns the single read on the bot token, so supervision cannot poll for itself
   * without the two stealing each other's replies. Supplying this sink is what lets both run on one
   * token in one window; `updateRouter.ts` decides which side each update belongs to.
   */
  supervisionSink?: (update: Record<string, unknown>) => void;
  /**
   * Message ids of supervision cards currently awaiting an answer, so a reply to one is recognised
   * as a decision rather than treated as text for a session.
   *
   * Without it, answering a card by replying to it *inside* a session topic would be read as a prompt
   * and typed into the agent instead of resolving the decision.
   */
  supervisionMessageIds?: () => Promise<ReadonlySet<string>>;
}

/**
 * One pass's view of the fleet, passed down instead of five positional arguments.
 *
 * `active` and `history` are the panel's two lists; `all` is the flat lookup, because targeting a
 * session by id has to work whichever list it is in — a topic opened from History still accepts
 * text.
 */
interface FleetView {
  active: ClaudeSession[];
  history: ClaudeSession[];
  all: ClaudeSession[];
  owners: Map<string, Ownership>;
  windows: WindowEntry[];
}

export class RemoteControlService {
  private readonly forum: ForumApi;
  private readonly topics: TopicStore;
  private readonly lease: ReaderLease;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running = false;

  /** Update offset for `getUpdates`. Held in memory by the reader; a handover re-reads from 0+1. */
  private offset = 0;
  /** The General list message, so it is edited rather than reposted. */
  private listMessageId: number | undefined;
  /** What the list last said, so it is only re-edited when the fleet actually changed. */
  private lastListSignature: string | undefined;
  /** Sessions shown in the last rendered list, so a button index resolves back to a session. */
  private lastListed: ClaudeSession[] = [];
  /** Sessions shown by the last `/history`, indexed separately so a stale tap cannot cross lists. */
  private lastHistory: ClaudeSession[] = [];
  /** Workspaces offered by the last `/new` menu, indexed the same way. */
  private lastNewMenu: Array<{ workspace: string; pid: number }> = [];
  /** Text recently injected per session, so the mirror does not echo the user's own prompt. */
  private readonly recentlySent = new Map<string, string[]>();
  /** True once a non-forum group has been reported, so it is said once and not every pass. */
  private warnedNotAForum = false;
  private lastSweep = 0;

  constructor(private readonly deps: RemoteControlDeps) {
    this.pid = deps.pid ?? process.pid;
    this.hostname = deps.hostname ?? os.hostname();
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
    this.forum = new ForumApi(deps.api, deps.config.chatId, deps.log);
    this.topics = new TopicStore(deps.homedir);
    this.lease = new ReaderLease({
      leasePath: leasePath(deps.homedir),
      pid: this.pid,
      host: this.hostname,
      now: this.now,
      log: deps.log,
    });
  }

  /** Start the loop, or explain why it cannot start. Never throws. */
  start(): void {
    const blocker = startupBlocker(this.deps.config);
    if (!this.deps.config.enabled) {
      this.log('remote control: disabled (sessionSitter.telegram.remoteControl=false)');
      return;
    }
    if (blocker !== null) {
      this.log(`remote control: not started — ${blocker}`);
      return;
    }
    this.log(
      `remote control: started on ${this.hostname} pid ${this.pid} — `
      + `chat=${this.deps.config.chatId} authorised=${this.deps.config.allowedUserIds.length}`,
    );
    this.schedule(0);
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    void this.lease.release();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) { return; }
    this.timer = setTimeout(() => { void this.pass(); }, delayMs);
  }

  /**
   * One full pass. A single failing pass must never kill the loop — a thrown error here would stop
   * every message being consumed, and every session going quiet, with nothing to say why.
   */
  private async pass(): Promise<void> {
    if (this.stopped || this.running) { return; }
    this.running = true;
    let isReader = false;
    try {
      isReader = await this.lease.tryAcquire();
      const windows = await readLiveWindows({ homedir: this.deps.homedir });
      // A daemon on this machine is the claimant of last resort, below both window tiers. Read here
      // as well as in the daemon so a window and the daemon compute the *same* owner for the same
      // session — two surfaces disagreeing about who is responsible is worse than either being wrong,
      // because then neither answer can be trusted.
      const daemon = await this.daemonClaimant();
      const { active, history } = await this.deps.partition();
      const all = [...active, ...history];
      const fleet: FleetView = {
        active, history, all, owners: resolveOwners(all, windows, daemon), windows,
      };

      await this.mirrorOwnedSessions(active, fleet.owners);
      await this.applyMyCommands(all, fleet.owners);
      if (isReader) {
        await this.readerPass(fleet);
      }
      await this.maybeSweep();
    } catch (err) {
      this.log(`remote control: pass error (continuing): ${String(err)}`);
    } finally {
      this.running = false;
      // The reader's long poll already blocked inside the pass, so it comes straight back.
      this.schedule(isReader ? 0 : IDLE_PASS_MS);
    }
  }

  // ------------------------------------------------------------------ mirroring (every window)

  /**
   * Keep a topic for each **active** session this window owns, and append its new turns.
   *
   * `active` is the panel's worklist, so the set of topics tracks the set of rows you would see in
   * the sidebar. A history session gets a topic only when you ask for one through `/history`;
   * auto-creating for everything is what filled the group with weeks of dead threads.
   */
  private async mirrorOwnedSessions(
    active: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    const mine = active.filter(s => owners.get(s.sessionId)?.pid === this.pid);
    for (const session of mine) {
      const existing = await this.topics.bySession(session.sessionId);
      if (existing === null) {
        await this.createTopicFor(session, owners.get(session.sessionId));
        continue;
      }
      await this.refreshTopic(session, existing);
    }
  }

  /** Create the topic and post its header. Returns the record, or null when creation failed. */
  private async createTopicFor(
    session: ClaudeSession, owner: Ownership | undefined,
  ): Promise<TopicRecord | null> {
    const name = topicName(session);
    const created = await this.forum.createTopic(name);
    if (!created.ok) {
      if (created.notAForum === true && !this.warnedNotAForum) {
        this.warnedNotAForum = true;
        this.log(
          'remote control: this chat is not a forum, so per-session topics cannot be created. '
          + 'Enable Topics in the group settings; the session list still works.',
        );
        await this.forum.send(
          'Topics are not enabled in this group, so each session cannot get its own thread. '
          + 'Turn on Topics in the group settings and the sessions will appear as threads.',
          null,
        );
      } else {
        this.log(`remote control: createTopic failed for ${session.sessionId}: ${created.error}`);
      }
      return null;
    }
    const resolved = owner ?? { pid: null, basis: 'none' as const, workspace: '' };
    // Start the cursor at the newest turn there is: a topic created now is a window onto what
    // happens next, not a replay of everything that already happened. Anchored by identity, because
    // a count cannot survive the reader's sliding window — see `MirrorCursor`.
    const known = await this.turnsOf(session.sessionId);
    const newest = known[known.length - 1];
    const record: TopicRecord = {
      threadId: created.value,
      sessionId: session.sessionId,
      source: session.source,
      name,
      nameSetAt: this.now(),
      mirroredTurns: known.length,
      mirroredKey: newest === undefined ? undefined : turnKey(newest),
      lastPostedAt: this.now(),
      closed: false,
      openedAt: this.now(),
      createdAt: this.now(),
    };
    // The topic exists in the group from here on, and the record is the only thing that can ever
    // reach it again — a bot cannot list a group's topics, so a topic with no record is in the
    // sidebar for good. If the write fails, take the topic back out rather than leaving a thread
    // nothing owns.
    try {
      await this.topics.save(record);
    } catch (err) {
      this.log(
        `remote control: could not record topic ${record.threadId} for ${session.sessionId} `
        + `(${String(err)}) — deleting it, because an unrecorded topic can never be cleaned up`);
      await this.forum.deleteTopic(record.threadId);
      return null;
    }
    await this.forum.send(
      renderTopicHeader(session, resolved, writeBlockedReason(session, resolved)),
      record.threadId,
      this.sessionButtons(session),
    );
    this.log(`remote control: topic ${record.threadId} created for ${session.sessionId}`);
    return record;
  }

  /**
   * Post new turns, rename on a status change that has waited its turn, and reopen a topic whose
   * session started talking.
   *
   * The rename is held rather than written on sight — `shouldRenameTopic` says why, and it is the
   * difference between a topic list and a stream of Telegram rename notices.
   *
   * Only ever called for a session that is currently active, so being active cannot itself be the
   * reason to reopen: a session open in a window stays active indefinitely, and reopening on that
   * alone would undo a topic you closed by hand on every single pass. **New turns** are what earn a
   * reopen, because they are the thing you would have missed.
   */
  private async refreshTopic(session: ClaudeSession, record: TopicRecord): Promise<void> {
    let changed = false;
    const now = this.now();

    const wanted = topicName(session);
    if (shouldRenameTopic(record, wanted, session.status, now, statusHoldMs(this.deps.config))) {
      const renamed = await this.forum.renameTopic(record.threadId, wanted);
      if (renamed.ok) {
        record.name = wanted;
        record.nameSetAt = now;
        changed = true;
      }
    }

    const turns = await this.turnsOf(session.sessionId);
    const plan = planMirror(turns, { key: record.mirroredKey, count: record.mirroredTurns }, {
      maxParts: effectiveMessageParts(this.deps.config),
      recentlySent: this.recentlySent.get(session.sessionId) ?? [],
      maxTurns: this.deps.config.maxTurnsPerPass,
      mirrorTools: this.deps.config.mirrorToolActivity,
      toolSampleMs: toolSampleMs(this.deps.config),
      lastPostedAt: record.lastPostedAt,
      now,
    });
    // Reopen before posting, not after: Telegram will not take a message into a closed topic, so
    // posting first would drop the very turns that justified the reopen.
    if (record.closed && plan.messages.length > 0) {
      const reopened = await this.forum.reopenTopic(record.threadId);
      if (reopened.ok) {
        record.closed = false;
        record.openedAt = this.now();
        changed = true;
      }
    }
    for (const message of plan.messages) {
      const posted = await this.forum.send(message, record.threadId);
      if (!posted.ok) {
        this.log(`remote control: mirror post failed on ${record.threadId}: ${posted.error}`);
        // Leave the cursor where it is so the turn is retried, unless we are being rate limited —
        // in which case retrying the same turn forever would wedge the topic.
        if (posted.retryAfterSeconds === undefined) {
          // The rename, if there was one, has already happened on Telegram's side, so it is saved
          // rather than lost to the early return — otherwise the next pass writes it again.
          if (changed) { await this.topics.save(record); }
          return;
        }
      }
    }
    if (plan.messages.length > 0) {
      // The quiet window a tool sample waits for is measured from here, so it is set for a spoken
      // turn as much as for a sample: one line a minute is the whole budget, whatever filled it.
      record.lastPostedAt = now;
      changed = true;
    }
    if (plan.nextCursor.key !== record.mirroredKey
      || plan.nextCursor.count !== record.mirroredTurns) {
      record.mirroredKey = plan.nextCursor.key;
      record.mirroredTurns = plan.nextCursor.count;
      changed = true;
    }
    if (changed) { await this.topics.save(record); }
  }

  /**
   * Delete the topic of any session that has left the active worklist.
   *
   * This is what keeps the group's topic list equal to the panel's session list. Without it a topic
   * created for a live session outlives it, and the sidebar grows by one dead thread per session
   * that ever ran — the very thing that made the group unusable.
   *
   * Deleted, not closed. Closing was the first attempt: Telegram keeps a closed topic in the topic
   * list, so the dead threads stayed exactly where they were, merely locked. The transcript on disk
   * is unaffected and stays the source of truth, so `/history` can build a fresh topic any time.
   *
   * Guarded on knowing *something*: a window whose session scan has not loaded yet reports an empty
   * fleet, and acting on that would delete every topic in the group. So an empty view is treated as
   * "no information", never as "nothing is active".
   */
  private async pruneInactiveTopics(
    active: ClaudeSession[], history: ClaudeSession[],
  ): Promise<void> {
    if (active.length === 0 && history.length === 0) { return; }
    const activeIds = new Set(active.map(s => s.sessionId));
    for (const record of topicsToDelete(await this.topics.all(), activeIds, this.now())) {
      const removed = await this.forum.deleteTopic(record.threadId);
      // A topic already deleted in the app is the same outcome as one deleted here: the record has
      // to go, or it is retried on every pass for as long as the group exists.
      if (removed.ok || removed.topicGone === true) {
        await this.topics.remove(record.threadId);
        this.log(
          `remote control: deleted topic ${record.threadId} — `
          + `${record.sessionId} is no longer active`);
        continue;
      }
      this.log(`remote control: could not delete topic ${record.threadId}: ${removed.error}`);
      // Most likely the bot lacks `can_manage_topics`. Fall back to the old behaviour so the thread
      // is at least locked, and keep the record so the delete is retried once the right is granted.
      if (!record.closed) {
        const closed = await this.forum.closeTopic(record.threadId);
        if (closed.ok) {
          record.closed = true;
          await this.topics.save(record);
        }
      }
    }
    await this.pruneDamagedTopics();
  }

  /**
   * Delete the topics whose record file can no longer be read.
   *
   * `topics.all()` skips an unreadable file, so without this the thread it names is not merely
   * unpruned — it is unreachable. A bot cannot ask Telegram what topics a group has
   * (`getForumTopics` is a user-API method), so the record is the only handle on a topic that exists,
   * and a record nobody can parse means a thread nobody can ever remove.
   *
   * The filename carries the thread id, which is the whole of what a delete needs. Whatever the
   * session was, it is not one this window can mirror any more, so the thread goes and the file goes
   * with it.
   */
  /**
   * Delete the topic a `/forget` was typed in.
   *
   * This is the manual counterpart to pruning, and it exists because pruning cannot be complete on
   * its own. Every automatic pass works from the record store, and the Bot API has no call that
   * lists a group's topics — `getForumTopics` belongs to the user-facing APIs — so a topic whose
   * record was never written or has since been lost is invisible to this extension entirely. It
   * cannot be counted, named, or removed. It simply stays in the group.
   *
   * A message typed inside such a thread carries its `message_thread_id`, which makes it the only
   * thing that can still point at one. So the user points, and the thread goes.
   *
   * An active session's topic is refused rather than deleted: it would only be recreated on the next
   * pass, and answering a request with a thread that reappears is worse than saying no.
   */
  private async forgetTopic(threadId: number | null, active: ClaudeSession[]): Promise<void> {
    if (threadId === null) {
      await this.forum.send(
        'Send /forget inside the topic you want removed. General cannot be deleted.', null);
      return;
    }
    const record = await this.topics.byThread(threadId);
    if (record !== null && active.some(s => s.sessionId === record.sessionId)) {
      await this.forum.send(
        'This topic belongs to an active session, so it would come straight back on the next pass. '
        + 'It is deleted automatically once the session leaves the worklist.',
        threadId,
      );
      return;
    }
    const removed = await this.forum.deleteTopic(threadId);
    if (removed.ok || removed.topicGone === true) {
      await this.topics.remove(threadId);
      this.log(`remote control: deleted topic ${threadId} on request`);
      return;
    }
    this.log(`remote control: could not delete topic ${threadId} on request: ${removed.error}`);
    await this.forum.send(
      `Could not delete this topic: ${removed.error}. The bot needs the "Manage topics" right in `
      + 'this group.',
      threadId,
    );
  }

  private async pruneDamagedTopics(): Promise<void> {
    for (const threadId of await this.topics.damagedThreadIds()) {
      const removed = await this.forum.deleteTopic(threadId);
      if (removed.ok || removed.topicGone === true) {
        await this.topics.remove(threadId);
        this.log(`remote control: deleted topic ${threadId} — its record could not be read`);
        continue;
      }
      this.log(`remote control: could not delete damaged topic ${threadId}: ${removed.error}`);
    }
  }

  /**
   * The recent turns of a session, whole rather than excerpted when full mode is on.
   *
   * The excerpt the panel uses is 250 characters, which is a reasonable preview beside the session
   * and useless as the only thing you can see of an answer you have to reply to. So the mirror asks
   * for the full text and `planMirror` splits it across messages.
   */
  private async turnsOf(sessionId: string) {
    try {
      return await this.deps.sessionManager.getRecentExchanges(sessionId, {
        full: this.deps.config.fullMessages,
        limit: MIRROR_TAIL_TURNS,
        // Asked for whenever sampling is on, because the sample is chosen from these. With it off the
        // mirror sees the conversation only, which is what it did before sampling existed.
        includeTools: this.deps.config.mirrorToolActivity,
      });
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ commands (every window)

  /** Take and run any bus command aimed at a session this window owns. */
  private async applyMyCommands(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    const pending = await readPendingCommands(this.deps.homedir);
    if (pending.length === 0) { return; }
    const ownedIds = new Set(
      sessions.filter(s => owners.get(s.sessionId)?.pid === this.pid).map(s => s.sessionId));

    for (const cmd of pending) {
      if (!commandIsMine(cmd, this.pid, ownedIds)) { continue; }
      if (!await claimCommand(cmd.cmdId, this.pid, this.deps.homedir)) { continue; }
      if (cmd.kind === 'sendText') { this.rememberSent(cmd.sessionId, cmd.text); }
      const result = await applyCommand(cmd, {
        pid: this.pid,
        bobSender: this.deps.bobSender,
        claudeSender: this.deps.claudeSender,
        launcher: this.deps.launcher,
        now: this.now,
        log: this.log,
      });
      await postResult(result, this.deps.homedir);
    }
  }

  private rememberSent(sessionId: string, text: string): void {
    const list = this.recentlySent.get(sessionId) ?? [];
    list.push(text);
    while (list.length > ECHO_MEMORY) { list.shift(); }
    this.recentlySent.set(sessionId, list);
  }

  // ------------------------------------------------------------------ reader only

  /**
   * The reader's extra work.
   *
   * Pruning lives here rather than in the per-window mirror because the topic list is one shared
   * thing, and the reader is already the window that owns the shared view — it renders the General
   * list. Doing it in every window would be harmless (closing is idempotent) but would multiply the
   * API calls by the number of windows for no gain.
   */
  private async readerPass(fleet: FleetView): Promise<void> {
    await this.pruneInactiveTopics(fleet.active, fleet.history);
    await this.refreshListIfChanged(fleet.active, fleet.owners);
    await this.reportResults(fleet);
    await this.reportUnroutable();
    await this.pollUpdates(fleet);
  }

  /** Post each finished command's outcome into the topic it came from. */
  private async reportResults(fleet: FleetView): Promise<void> {
    for (const result of await takeResults(this.deps.homedir)) {
      const prefix = result.ok ? '✅' : '⚠';
      // A `newSession` result carries the id of what it started, so its topic is created here rather
      // than waited for. The mirror only makes topics for sessions in the *active worklist*, and the
      // worklist is built from transcripts — so before this, a freshly started session had no topic
      // until somebody spoke to it in the IDE, which is exactly what they were trying to do from here.
      const threadId = result.sessionId
        ? await this.ensureTopicForNewSession(result.sessionId, fleet)
        : null;
      await this.forum.send(`${prefix} ${result.detail}`, threadId ?? result.threadId ?? null);
    }
  }

  /**
   * The topic for a session that has just been started, creating it if the mirror has not yet.
   *
   * Returns the thread to report into, or null when no topic could be made — in which case the caller
   * still reports, in General. A launch the user cannot read about is worse than one reported in the
   * wrong place.
   *
   * The session is usually not in `fleet.all` yet: this runs on the same pass that started it, and the
   * worklist was read before it existed. So a minimal stand-in is built from the id when it is absent,
   * which is enough for a topic name and header — and the next pass replaces the header with the real
   * one once the transcript is on disk.
   */
  private async ensureTopicForNewSession(
    sessionId: string, fleet: FleetView,
  ): Promise<number | null> {
    const existing = await this.topics.bySession(sessionId);
    if (existing !== null) { return existing.threadId; }

    const known = fleet.all.find(s => s.sessionId === sessionId);
    const session: ClaudeSession = known ?? {
      sessionId,
      projectName: '',
      projectPath: '',
      title: 'new session',
      updatedAt: new Date(this.now()),
      status: 'working',
      source: 'claude',
    };
    const record = await this.createTopicFor(session, fleet.owners.get(sessionId));
    return record?.threadId ?? null;
  }

  /**
   * Report commands nobody claimed.
   *
   * This is the case where the user typed into a topic whose session has no live window — the
   * message would otherwise just disappear. Saying so is the whole point.
   */
  private async reportUnroutable(): Promise<void> {
    const pending = await readPendingCommands(this.deps.homedir);
    for (const cmd of expiredCommands(pending, this.now())) {
      await dropCommand(cmd.cmdId, this.deps.homedir);
      await this.forum.send(
        '⚠ No open window is responsible for that session, so nothing was sent. '
        + 'Open its workspace in VS Code and try again.',
        cmd.threadId || null,
      );
    }
  }

  private async pollUpdates(fleet: FleetView): Promise<void> {
    let resp: Record<string, unknown>;
    try {
      resp = await this.deps.api('getUpdates', {
        offset: this.offset + 1, timeout: LONG_POLL_SECONDS,
      });
    } catch (err) {
      // Surfaced, never swallowed: a silent getUpdates failure is indistinguishable from an idle
      // chat, so every message would appear to be ignored with no explanation anywhere.
      this.log(`remote control: getUpdates failed: ${String(err)}`);
      await new Promise(resolve => setTimeout(resolve, LEASE_RENEW_MS));
      return;
    }
    const updates = Array.isArray(resp.result) ? resp.result : [];
    if (updates.length === 0) { return; }

    // This window holds the ONLY read on this token, so supervision's updates arrive here too and
    // have to be handed on. Attribution is by callback prefix and by where a message was typed —
    // see `updateRouter.ts`.
    const sessionThreadIds = new Set((await this.topics.all()).map(t => t.threadId));
    let supervisionMessageIds: ReadonlySet<string> = new Set<string>();
    try {
      supervisionMessageIds = await this.deps.supervisionMessageIds?.() ?? new Set<string>();
    } catch (err) {
      // An unreadable record store must not stop updates being routed; the worst case is one card
      // answered by a text reply being treated as a prompt.
      this.log(`remote control: could not read live supervision cards: ${String(err)}`);
    }

    for (const raw of updates) {
      const update = (raw ?? {}) as Record<string, unknown>;
      const id = typeof update.update_id === 'number' ? update.update_id : this.offset;
      this.offset = Math.max(this.offset, id);

      if (routeUpdate(update, { sessionThreadIds, supervisionMessageIds }) === 'supervision') {
        if (this.deps.supervisionSink !== undefined) {
          this.deps.supervisionSink(update);
        }
        continue;
      }

      const intent = classifyUpdate(update, {
        chatId: this.deps.config.chatId,
        allowedUserIds: this.deps.config.allowedUserIds,
      });
      await this.handleIntent(intent, fleet);
    }
  }

  private async handleIntent(intent: Intent, fleet: FleetView): Promise<void> {
    switch (intent.kind) {
      case 'ignore':
        return;

      case 'unauthorized':
        // Logged with the id and nothing else. The id is what the user needs in order to add
        // someone; the message body is not ours to read.
        this.log(
          `remote control: ignored a message from unauthorised Telegram user ${intent.userId}. `
          + 'Add it to sessionSitter.telegram.allowedUserIds to permit it.',
        );
        return;

      case 'help':
        await this.forum.send(renderHelp(), null);
        return;

      case 'listSessions':
        await this.renderList(fleet.active, fleet.owners);
        return;

      case 'listHistory':
        await this.renderHistory(fleet.history, fleet.owners);
        return;

      case 'who':
        await this.forum.send(
          renderWho(this.entriesOf(fleet.active, fleet.owners), this.hostname), null);
        return;

      case 'newSessionMenu':
        await this.sendNewMenu(fleet.windows);
        return;

      case 'forgetTopic':
        await this.forgetTopic(intent.threadId, fleet.active);
        return;

      case 'sendToTopic':
        await this.routeTopicText(intent.threadId, intent.text, fleet.all, fleet.owners);
        return;

      case 'unroutableText':
        await this.forum.send(
          'That was sent to General, which is not a session. Open a session topic and type there, '
          + 'or use /sessions to see what is running.',
          null,
        );
        return;

      case 'callback':
        await this.handleCallback(intent, fleet);
        return;
    }
  }

  private entriesOf(sessions: ClaudeSession[], owners: Map<string, Ownership>): ListEntry[] {
    return sessions.map(session => ({
      session,
      owner: owners.get(session.sessionId) ?? { pid: null, basis: 'none' as const, workspace: '' },
    }));
  }

  /** Render (or edit) the single General list message. Active sessions only, as the panel shows. */
  private async renderList(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    this.lastListed = sessions.slice(0, 24); // button indexes address this snapshot
    // Recorded here rather than by the caller, so an on-demand `/sessions` and an automatic refresh
    // leave the same mark and neither re-edits what the other just drew.
    this.lastListSignature = fleetSignature(this.entriesOf(sessions, owners));
    const body = renderFleetList(this.entriesOf(this.lastListed, owners), this.hostname, this.now());
    const markup = this.listButtons();
    if (this.listMessageId !== undefined) {
      const edited = await this.forum.edit(this.listMessageId, body, markup);
      if (edited.ok) { return; }
      // The message may have been deleted in the app; fall through and post a fresh one.
      this.listMessageId = undefined;
    }
    const sent = await this.forum.send(body, null, markup);
    if (sent.ok) {
      this.listMessageId = sent.value;
      await this.forum.pin(sent.value);
    }
  }

  /**
   * Keep the pinned list honest without being asked.
   *
   * A session that leaves the worklist has to leave the list, not sit there until someone taps
   * Refresh — a stale list is worse than no list, because it is believed. So the reader re-renders
   * whenever the fleet changes.
   *
   * "Changes" deliberately excludes the ages in each row: those tick on every pass, and treating
   * them as a change would mean editing a pinned message every few seconds and being rate limited
   * for no information. What counts is which sessions there are, what state each is in, and whether
   * it can be written to.
   *
   * Nothing is posted if the list has never been asked for. An unprompted message in General is not
   * this feature's decision to make.
   */
  private async refreshListIfChanged(
    active: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    if (this.listMessageId === undefined) { return; }
    const signature = fleetSignature(this.entriesOf(active, owners));
    if (signature === this.lastListSignature) { return; }
    await this.renderList(active, owners);
  }

  private listButtons(): ReplyMarkup {
    const rows = this.lastListed.slice(0, 8).map((session, index) => ([{
      text: `${session.projectName} / ${session.title}`.slice(0, 40),
      callback_data: encodeCallback({ kind: 'openSession', index }),
    }]));
    rows.push([
      { text: '⟳ Refresh', callback_data: encodeCallback({ kind: 'refresh' }) },
      { text: '＋ New', callback_data: encodeCallback({ kind: 'newMenu' }) },
      { text: '🗄 History', callback_data: encodeCallback({ kind: 'history' }) },
    ]);
    return { inline_keyboard: rows };
  }

  /**
   * `/history` — the sessions the worklist does not show, each a button that brings one back.
   *
   * Posted fresh rather than edited in place like the General list: history is something you go and
   * look at, not a board you watch, and a pinned second live message would compete with the first.
   */
  private async renderHistory(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    this.lastHistory = sessions.slice(0, 8); // button indexes address this snapshot
    const rows = this.lastHistory.map((session, index) => ([{
      text: sessionLabel(session, 24).slice(0, 40),
      callback_data: encodeCallback({ kind: 'loadHistory', index }),
    }]));
    rows.push([{ text: '⟳ Active sessions', callback_data: encodeCallback({ kind: 'refresh' }) }]);
    await this.forum.send(
      renderHistoryList(this.entriesOf(this.lastHistory, owners), this.now()),
      null,
      { inline_keyboard: rows });
  }

  private sessionButtons(session: ClaudeSession): ReplyMarkup {
    return {
      inline_keyboard: [[
        { text: '📄 Full transcript', callback_data: encodeCallback({ kind: 'transcript', sessionId: session.sessionId }) },
      ], [
        { text: '👁 Focus in IDE', callback_data: encodeCallback({ kind: 'focus', sessionId: session.sessionId }) },
      ]],
    };
  }

  /**
   * Open a session's topic, creating it when there is none. Returns the record, or null on failure.
   *
   * Only the owning window may create a topic, so the window that mirrors a session is the window
   * that made its topic. A session no window owns gets one from the reader instead, read-only —
   * better a thread you can read than a tap that appears to do nothing.
   */
  private async openTopicFor(
    session: ClaudeSession, owner: Ownership | undefined, listCommand: string,
  ): Promise<TopicRecord | null> {
    const existing = await this.topics.bySession(session.sessionId);
    if (existing !== null) {
      if (existing.closed) {
        const reopened = await this.forum.reopenTopic(existing.threadId);
        if (reopened.ok) { existing.closed = false; }
      }
      // Stamped whether or not it was closed: you asked for this topic, so the pruner leaves it
      // alone for a while even though its session is not in the worklist.
      existing.openedAt = this.now();
      await this.topics.save(existing);
      await this.forum.send('Here.', existing.threadId);
      return existing;
    }
    if (owner !== undefined && owner.pid !== null && owner.pid !== this.pid) {
      await this.forum.send(
        `That session belongs to the window with pid ${owner.pid}; its topic will appear shortly. `
        + `Use ${listCommand} again if it does not.`,
        null);
      return null;
    }
    const created = await this.createTopicFor(session, owner);
    if (created === null) {
      await this.forum.send('Could not create a topic for that session.', null);
    }
    return created;
  }

  /**
   * `/new` — one button per (workspace, window) on this machine.
   *
   * The list comes from the live window registry rather than a configured allowlist: a window is
   * what makes a workspace controllable, so this cannot offer a target that nothing could run.
   */
  private async sendNewMenu(windows: WindowEntry[]): Promise<void> {
    // One entry per distinct folder, with the window chosen by `chooseLaunchTarget` rather than by
    // "whichever listed it first". That pairing was the bug behind a session opening somewhere the
    // user had not picked: a folder in a multi-root window would open a panel whose session reported
    // one of that window's *other* folders, silently.
    const folders = [...new Set(windows.flatMap(w => w.workspaceFolders))];
    this.lastNewMenu = [];
    const caveats: string[] = [];
    for (const folder of folders) {
      const target = chooseLaunchTarget(windows, folder);
      if (target.certainty === 'none') { continue; }
      this.lastNewMenu.push({ workspace: folder, pid: target.pid });
      const caveat = targetCaveat(target);
      if (caveat !== null) {
        const name = folder.split(/[/\\]/).pop() ?? folder;
        caveats.push(`· ${name}: ${caveat}`);
      }
    }
    if (this.lastNewMenu.length === 0) {
      await this.forum.send('No VS Code window is open on this machine, so there is nowhere to start a session.', null);
      return;
    }
    const rows = this.lastNewMenu.slice(0, 8).flatMap((entry, index) => {
      const name = entry.workspace.split(/[/\\]/).pop() ?? entry.workspace;
      return [[
        { text: `claude · ${name}`.slice(0, 40), callback_data: encodeCallback({ kind: 'launch', index, source: 'claude' }) },
        { text: `bob · ${name}`.slice(0, 40), callback_data: encodeCallback({ kind: 'launch', index, source: 'bob' }) },
      ]];
    });
    // Warned before the tap, not after: once the session exists in the wrong folder the only remedy is
    // to close it and start again, which costs the round trip the warning would have saved.
    const text = caveats.length === 0
      ? 'Start a new session where?'
      : `Start a new session where?\n\nSome folders cannot be guaranteed:\n${caveats.join('\n')}`;
    await this.forum.send(text, null, { inline_keyboard: rows });
  }

  /**
   * Free text typed in a session topic.
   *
   * When this window owns the session it could act directly, but the command still goes on the bus:
   * one path means one place where claiming, results and reporting are handled, and the owner picks
   * its own command up on the same pass.
   */
  private async routeTopicText(
    threadId: number,
    text: string,
    sessions: ClaudeSession[],
    owners: Map<string, Ownership>,
  ): Promise<void> {
    const record = await this.topics.byThread(threadId);
    if (record === null) {
      await this.forum.send(
        'This topic is not linked to a session, so there is nothing to send to. '
        + 'Use /sessions in General to pick one.',
        threadId);
      return;
    }
    const session = sessions.find(s => s.sessionId === record.sessionId);
    if (session === undefined) {
      await this.forum.send(
        'That session no longer exists, so nothing was sent.', threadId);
      return;
    }
    const owner = owners.get(session.sessionId) ?? { pid: null, basis: 'none' as const, workspace: '' };
    const blocked = writeBlockedReason(session, owner);
    if (blocked !== null) {
      await this.forum.send(`⚠ ${blocked}`, threadId);
      return;
    }
    await postCommand({
      cmdId: newCommandId(),
      kind: 'sendText',
      sessionId: session.sessionId,
      source: session.source,
      text,
      threadId,
      issuedAt: this.now(),
    }, this.deps.homedir);
  }

  private async handleCallback(
    intent: Extract<Intent, { kind: 'callback' }>,
    fleet: FleetView,
  ): Promise<void> {
    const cb = decodeCallback(intent.data);
    await this.forum.answerCallback(intent.callbackId, 'Working…');
    switch (cb.kind) {
      case 'refresh':
        await this.renderList(fleet.active, fleet.owners);
        return;

      case 'newMenu':
        await this.sendNewMenu(fleet.windows);
        return;

      case 'history':
        await this.renderHistory(fleet.history, fleet.owners);
        return;

      case 'openSession': {
        const session = this.lastListed[cb.index];
        if (session === undefined) {
          await this.forum.send('That list is out of date — use /sessions again.', null);
          return;
        }
        await this.openTopicFor(session, fleet.owners.get(session.sessionId), '/sessions');
        return;
      }

      case 'loadHistory': {
        const session = this.lastHistory[cb.index];
        if (session === undefined) {
          await this.forum.send('That list is out of date — use /history again.', null);
          return;
        }
        const owner = fleet.owners.get(session.sessionId);
        const record = await this.openTopicFor(session, owner, '/history');
        // Opening the topic gives you the session to read. Focusing it in the IDE is what actually
        // brings it back into the active list, because "active" means a window has it open — so the
        // panel and this list agree about it again from the next pass onward.
        if (record !== null && owner !== undefined && owner.pid !== null) {
          await postCommand({
            cmdId: newCommandId(),
            kind: 'focus',
            sessionId: session.sessionId,
            source: session.source,
            text: '',
            threadId: record.threadId,
            issuedAt: this.now(),
          }, this.deps.homedir);
        } else {
          await this.forum.send(
            'No window on this machine owns that session, so it cannot be reopened in an IDE. '
            + 'You can still read it here.',
            record?.threadId ?? null);
        }
        return;
      }

      case 'launch': {
        const target = this.lastNewMenu[cb.index];
        if (target === undefined) {
          await this.forum.send('That menu is out of date — use /new again.', null);
          return;
        }
        await postCommand({
          cmdId: newCommandId(),
          kind: 'newSession',
          sessionId: '',
          source: cb.source,
          text: target.workspace,
          targetPid: target.pid,
          threadId: 0,
          issuedAt: this.now(),
        }, this.deps.homedir);
        return;
      }

      case 'focus': {
        const session = fleet.all.find(s => s.sessionId === cb.sessionId);
        if (session === undefined) { return; }
        const record = await this.topics.bySession(cb.sessionId);
        await postCommand({
          cmdId: newCommandId(),
          kind: 'focus',
          sessionId: cb.sessionId,
          source: session.source,
          text: '',
          threadId: record?.threadId ?? 0,
          issuedAt: this.now(),
        }, this.deps.homedir);
        return;
      }

      case 'transcript':
        await this.sendTranscript(cb.sessionId, intent.threadId);
        return;

      case 'closeTopic': {
        const closed = await this.forum.closeTopic(cb.threadId);
        if (closed.ok) {
          const record = await this.topics.byThread(cb.threadId);
          if (record !== null) { record.closed = true; await this.topics.save(record); }
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * Deliver a full transcript.
   *
   * A transcript is far past Telegram's 4096-character message limit, so it has to be a file
   * upload — which needs multipart/form-data that the JSON `ApiFn` cannot express. Without an
   * uploader wired in, the user is told so rather than getting silence.
   */
  private async sendTranscript(sessionId: string, threadId: number | null): Promise<void> {
    let markdown: string | null = null;
    try {
      markdown = await this.deps.sessionManager.exportFullTranscript(sessionId);
    } catch (err) {
      this.log(`remote control: transcript export failed for ${sessionId}: ${String(err)}`);
    }
    if (markdown === null) {
      await this.forum.send('Could not export that transcript.', threadId);
      return;
    }
    const sent = await this.forum.sendDocument(
      threadId, `${sessionId}.md`, markdown, 'Full transcript', this.uploader());
    if (!sent.ok) {
      this.log(`remote control: transcript upload failed: ${sent.error}`);
      await this.forum.send(
        'Could not upload the transcript file. It is available from the Sessions panel.', threadId);
    }
  }

  /**
   * Multipart uploader for `sendDocument`, built from the bot token.
   *
   * Separate from `ApiFn` because that abstraction is JSON-only, and widening it would touch the
   * supervision channel for no benefit there.
   */
  private uploader(): ((form: FormData) => Promise<Record<string, unknown>>) | undefined {
    const token = this.deps.config.botToken;
    if (!token) { return undefined; }
    return async (form: FormData) => {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST', body: form,
      });
      return await resp.json() as Record<string, unknown>;
    };
  }

  private async maybeSweep(): Promise<void> {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_AFTER_MS) { return; }
    this.lastSweep = now;
    await sweep(SWEEP_AFTER_MS, now, this.deps.homedir);
  }

  /**
   * Post a supervision card into its own session's topic when one exists.
   *
   * Called by the extension so a decision about a session appears beside the conversation with that
   * session, rather than in one undifferentiated feed. Returns false when there is no topic, and
   * the caller falls back to the existing channel.
   */
  async postToSessionTopic(sessionId: string, text: string): Promise<boolean> {
    if (!this.deps.config.enabled) { return false; }
    const record = await this.topics.bySession(sessionId);
    if (record === null) { return false; }
    const sent = await this.forum.send(text, record.threadId);
    return sent.ok;
  }

  /**
   * The `session-sitter daemon` on this machine, when one is running and working.
   *
   * `running` and nothing else: a wedged daemon claiming sessions would take them off the read-only
   * tier and then fail to serve them, and the list would say somebody had.
   */
  private async daemonClaimant(): Promise<DaemonClaimant | null> {
    const beat = await readHeartbeat(heartbeatPath());
    return daemonClaimantFrom(beat, health(beat, Date.now(), pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }));
  }

  /** Ownership of one session, for callers that need to know before acting. */
  async ownerOf(session: ClaudeSession, windows: WindowEntry[]): Promise<Ownership> {
    return resolveOwner(session, windows, await this.daemonClaimant());
  }

  /** Publish a command from outside the loop (used by the debug command). */
  async issue(cmd: BusCommand): Promise<void> {
    await postCommand(cmd, this.deps.homedir);
  }
}
