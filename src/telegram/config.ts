/**
 * Settings for the Telegram remote-control feature.
 *
 * The bot token and chat id are not among them: they are reused from the supervision settings
 * (`sessionSitter.supervisor.telegram*`), because remote control and supervision belong in the
 * *same* group — a decision card for a session and the conversation with that session should not
 * live in two different places.
 *
 * ## Why one bot per machine, and why the token should not be a setting
 *
 * A bot token has one update stream and reading it is destructive, so two machines sharing a token
 * steal each other's messages. Each machine therefore needs its own bot. VS Code's User settings
 * are exactly the wrong place to keep that: Settings Sync would copy one machine's token to all of
 * them, recreating the problem invisibly.
 *
 * So the token is best kept per machine, in the environment or a `.env` file, which the existing
 * config layer already reads as a fallback. The setting still works — it is checked first — but the
 * documentation steers to the environment, and `describeTokenSource` reports which one was used so
 * a synced-token mistake is at least visible in the log.
 */

import {
  MAX_MESSAGE_PARTS_DEFAULT, MAX_MESSAGE_PARTS_LIMIT, MAX_TURNS_PER_PASS_DEFAULT,
  MAX_TURNS_PER_PASS_LIMIT, STATUS_HOLD_SECONDS_DEFAULT, TOOL_SAMPLE_SECONDS_DEFAULT,
} from './render';
import type { SupervisorConfig } from '../supervisor/config';

export interface RemoteControlConfig {
  /** The master switch. Off means nothing in this feature runs at all. */
  enabled: boolean;
  botToken: string;
  /** Forum group id. Negative for a group, which is normal and not an error. */
  chatId: string;
  /** Telegram user ids permitted to drive the bot. Empty authorises nobody. */
  allowedUserIds: string[];
  /** Mirror the whole text of a turn, split over several messages, rather than a short preview. */
  fullMessages: boolean;
  /** Messages one turn may be split into. Clamped to 1..`MAX_MESSAGE_PARTS_LIMIT`. */
  maxMessageParts: number;
  /**
   * Seconds a topic name is held at what it last said before a status change is written. 0 writes
   * every change, which is what the feature did before the setting existed.
   */
  statusHoldSeconds: number;
  /** Post sampled tool activity into a topic at all, so a working session is visibly working. */
  mirrorToolActivity: boolean;
  /** Seconds a topic must have been quiet before one line of tool activity is sampled into it. */
  toolActivitySeconds: number;
  /** Spoken turns one pass may post before the overflow collapses into a line. */
  maxTurnsPerPass: number;
}

/** What a settings reader has to provide. Keeps this module free of the `vscode` module. */
export interface SettingsReader {
  getBoolean(key: string, fallback: boolean): boolean;
  getStringArray(key: string, fallback: string[]): string[];
  getNumber(key: string, fallback: number): number;
}

/**
 * Build the config from settings plus the already-resolved supervisor config (which has done the
 * environment and `.env` fallback for the token and chat id).
 *
 * Ids are normalised to trimmed strings because Telegram ids are numeric but arrive as JSON numbers
 * or strings depending on where they were copied from, and a numeric `12345` that fails to match
 * the string `"12345"` is a silent authorisation failure — the worst kind.
 */
export function remoteControlConfigFrom(
  settings: SettingsReader, supervisor: SupervisorConfig,
): RemoteControlConfig {
  return {
    enabled: settings.getBoolean('telegram.remoteControl', false),
    botToken: (supervisor.telegramBotToken ?? '').trim(),
    chatId: (supervisor.telegramChatId ?? '').trim(),
    allowedUserIds: settings
      .getStringArray('telegram.allowedUserIds', [])
      .map(id => String(id).trim())
      .filter(id => id.length > 0),
    fullMessages: settings.getBoolean('telegram.fullMessages', true),
    maxMessageParts: clampParts(
      settings.getNumber('telegram.maxMessageParts', MAX_MESSAGE_PARTS_DEFAULT)),
    statusHoldSeconds: clampSeconds(
      settings.getNumber('telegram.statusHoldSeconds', STATUS_HOLD_SECONDS_DEFAULT),
      STATUS_HOLD_SECONDS_DEFAULT),
    mirrorToolActivity: settings.getBoolean('telegram.mirrorToolActivity', true),
    toolActivitySeconds: clampSeconds(
      settings.getNumber('telegram.toolActivitySeconds', TOOL_SAMPLE_SECONDS_DEFAULT),
      TOOL_SAMPLE_SECONDS_DEFAULT),
    maxTurnsPerPass: clampTurns(
      settings.getNumber('telegram.maxTurnsPerPass', MAX_TURNS_PER_PASS_DEFAULT)),
  };
}

/** An hour's ceiling on the two second-valued settings, and 0 kept as "no delay at all". */
const MAX_INTERVAL_SECONDS = 3600;

/**
 * A whole number of seconds, 0..an hour.
 *
 * Zero is meaningful for both of these — it turns the hold off and the sampling into "every pass" —
 * so it is kept rather than floored to a minimum. A negative or non-numeric value is a hand-edited
 * `settings.json`, and falls back to the default rather than becoming a window that never closes.
 */
function clampSeconds(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) { return fallback; }
  return Math.min(MAX_INTERVAL_SECONDS, Math.floor(value));
}

/** The per-pass turn budget, held inside what one topic may spend of the group's minute. */
function clampTurns(value: number): number {
  if (!Number.isFinite(value)) { return MAX_TURNS_PER_PASS_DEFAULT; }
  return Math.min(MAX_TURNS_PER_PASS_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * Hold the parts budget inside what Telegram will actually take.
 *
 * A group accepts on the order of 20 messages a minute, so a budget above that lets one long answer
 * hold up every other topic for over a minute. Clamped rather than reported as a setup error: a
 * number too large is a guess about how the limit works, not a broken configuration, and refusing
 * to start over it would be out of proportion.
 *
 * A non-number reaches here whenever `settings.json` has been hand-edited, so it falls back to the
 * default instead of turning into `NaN` and silently mirroring nothing.
 */
function clampParts(value: number): number {
  if (!Number.isFinite(value)) { return MAX_MESSAGE_PARTS_DEFAULT; }
  return Math.min(MAX_MESSAGE_PARTS_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * The parts budget the mirror should actually use — 1 when full mode is off.
 *
 * Combining the two settings in one place means the service never has to, so "full mode off" cannot
 * come to mean something subtly different in two call sites.
 */
export function effectiveMessageParts(config: RemoteControlConfig): number {
  return config.fullMessages ? config.maxMessageParts : 1;
}

/** The rename hold in milliseconds, which is what `shouldRenameTopic` compares against. */
export function statusHoldMs(config: RemoteControlConfig): number {
  return config.statusHoldSeconds * 1000;
}

/** The tool-sample quiet window in milliseconds, which is what `planMirror` compares against. */
export function toolSampleMs(config: RemoteControlConfig): number {
  return config.toolActivitySeconds * 1000;
}

/**
 * Why the feature cannot start, or null when it can.
 *
 * An empty allowlist is a hard stop rather than a warning. The feature would otherwise run,
 * connect, create topics and silently discard every message — which looks like a bug in the bot
 * rather than an unfinished setup.
 */
export function startupBlocker(config: RemoteControlConfig): string | null {
  if (!config.enabled) { return null; }
  if (!config.botToken) {
    return 'no bot token: set TELEGRAM_BOT_TOKEN in the environment or a .env file '
      + '(preferred, since each machine needs its own bot), or '
      + 'sessionSitter.supervisor.telegramBotToken';
  }
  if (!config.chatId) {
    return 'no chat id: set TELEGRAM_CHAT_ID or sessionSitter.supervisor.telegramChatId '
      + 'to the forum group id';
  }
  if (config.allowedUserIds.length === 0) {
    return 'sessionSitter.telegram.allowedUserIds is empty, so no sender is authorised. '
      + 'Message the group and the ids that were seen are logged for you to copy in';
  }
  return null;
}
