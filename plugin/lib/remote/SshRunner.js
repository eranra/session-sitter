// GENERATED FILE — DO NOT EDIT.
// Compiled from src/remote/SshRunner.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SshRunner = exports.BACKOFF_CAP_MS = exports.BACKOFF_BASE_MS = void 0;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * The one place this extension opens an SSH connection.
 *
 * Same discipline as `BobDatabase.ts` is for SQLite: a single module owns the transport, so the
 * flags that make it safe and the failure handling that keeps it quiet are in one auditable spot
 * instead of scattered across call sites.
 *
 * ## Why BatchMode is not optional
 *
 * Peers are discovered automatically, so the extension will try to reach hosts the user never
 * explicitly pointed it at. Without `BatchMode=yes`, a host needing a password or a key
 * passphrase would leave `ssh` waiting on a prompt that no one can see or answer — a background
 * timer wedged forever. With it, such a host fails immediately and is simply reported unreachable.
 *
 * ## Why ControlMaster
 *
 * Remote sessions refresh on a timer. A fresh TCP connect plus key exchange on every pass is real
 * load on both ends and slow over a VPN, so connections are multiplexed: the first call sets up a
 * master socket and later calls reuse it.
 *
 * ## Why the socket path is built here instead of with `%C`
 *
 * A unix socket path is capped at 104 bytes on macOS (108 on Linux), and ssh's `%C` token expands
 * to a 40-character hash. Under a macOS `os.tmpdir()` — `/var/folders/<x>/<random>/T` — the two
 * together blew past the cap, ssh refused every connection with `ControlPath too long`, and the
 * panel reported each peer unreachable forever. So the peer's digest is computed here, short and
 * literal, where its length can actually be checked before ssh is asked to bind it.
 *
 * And multiplexing is treated as what it is: an optimisation. If even the short path will not fit,
 * the connection is made without it. Slower beats a feature that silently reports nothing.
 *
 * ## Why anything substantial travels on stdin
 *
 * `ssh host cmd a b` does **not** preserve argv. ssh joins the words with spaces and hands the
 * result to a shell on the far side, which re-splits and expands it. A multi-line script passed
 * as an argument is therefore torn apart, and any value containing shell metacharacters is an
 * injection point.
 *
 * So the rule here is: send programs and data over **stdin**, and keep remote argv to short
 * literals the caller controls. Callers that must pass a value should encode it into a
 * shell-inert alphabet (base64) rather than trust quoting.
 */
/** First backoff window after a peer fails. */
exports.BACKOFF_BASE_MS = 30000;
/** Longest a peer is ever left alone; a host down for a week is retried every 15 minutes. */
exports.BACKOFF_CAP_MS = 15 * 60000;
const CONNECT_TIMEOUT_S = 10;
const CONTROL_PERSIST_S = 60;
const DEFAULT_TIMEOUT_MS = 20000;
/** `sun_path` is 104 bytes on macOS/BSD and 108 on Linux; the smaller one is the portable rule. */
const MAX_SOCKET_PATH = 104;
/**
 * Room left below the cap, because the path we pass is not the longest one ssh binds: while
 * bringing a master up it appends `.<pid>` and renames the result into place.
 */
const SOCKET_PATH_HEADROOM = 12;
const realExec = (file, args, opts) => new Promise((resolve, reject) => {
    // spawn rather than execFile, because the probe script is delivered on stdin.
    const child = (0, child_process_1.spawn)(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > opts.maxBuffer) {
            overflowed = true;
            child.kill('SIGKILL');
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < 8192) {
        stderr += chunk;
    } });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) {
            reject(new Error(`ssh timed out after ${opts.timeout}ms`));
            return;
        }
        if (overflowed) {
            reject(new Error('ssh output exceeded the size limit'));
            return;
        }
        if (code !== 0) {
            reject(new Error(stderr.trim() || `ssh exited with code ${code}`));
            return;
        }
        resolve({ stdout });
    });
    // EPIPE is normal here: the remote command may exit before reading all of stdin.
    child.stdin.on('error', () => { });
    child.stdin.end(opts.stdin ?? '');
});
class SshRunner {
    constructor(opts = {}) {
        this._failures = new Map();
        this._exec = opts.exec ?? realExec;
        this._now = opts.now ?? Date.now;
        // Short on purpose — every character here is one fewer available to the socket name below.
        this._controlDir = opts.controlDir
            ?? path.join(os.tmpdir(), `ss-ssh-${process.getuid?.() ?? 0}`);
    }
    /**
     * Run one command on a peer and return its stdout.
     *
     * Rejects without connecting when the peer is inside its backoff window, so a decommissioned
     * host costs nothing on later passes.
     */
    async run(peer, argv, opts = {}) {
        const wait = this.retryInMs(peer);
        if (wait > 0) {
            throw new Error(`peer ${peer.raw} is backed off for another ${Math.ceil(wait / 1000)}s `
                + `(${this._failures.get(peer.raw)?.reason ?? 'unreachable'})`);
        }
        this._ensureControlDir();
        try {
            const { stdout } = await this._exec('ssh', [...this._sshOptions(peer), peer.raw, ...argv], { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, stdin: opts.stdin });
            this._failures.delete(peer.raw);
            return stdout;
        }
        catch (err) {
            this._recordFailure(peer, err);
            throw err;
        }
    }
    /** Current backoff width for a peer; 0 when it is healthy. */
    backoffMs(peer) {
        const state = this._failures.get(peer.raw);
        if (!state) {
            return 0;
        }
        return Math.min(exports.BACKOFF_BASE_MS * 2 ** (state.count - 1), exports.BACKOFF_CAP_MS);
    }
    /** Milliseconds until this peer may be tried again; 0 when it may be tried now. */
    retryInMs(peer) {
        const state = this._failures.get(peer.raw);
        if (!state) {
            return 0;
        }
        return Math.max(0, state.retryAt - this._now());
    }
    /** Why this peer last failed, for display in the panel. */
    lastError(peer) {
        return this._failures.get(peer.raw)?.reason;
    }
    _sshOptions(peer) {
        const options = [
            // Never prompt. See the class comment: this is what keeps automatic discovery safe.
            '-o', 'BatchMode=yes',
            '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
        ];
        const socket = this._controlPath(peer);
        // Too long to bind means no multiplexing, not a failed connection. See the class comment.
        if (socket.length + SOCKET_PATH_HEADROOM > MAX_SOCKET_PATH) {
            return options;
        }
        return [
            ...options,
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${socket}`,
            '-o', `ControlPersist=${CONTROL_PERSIST_S}`,
        ];
    }
    /**
     * Where this peer's multiplexing socket lives — one per peer, so a second peer never waits behind
     * the first, and the same peer always reuses the warm connection.
     *
     * Keyed by `peer.raw`, which is how every other map in this class keys a peer, and truncated to
     * 12 hex characters: this only has to separate the handful of peers one user's IDE has recorded,
     * and each character costs budget against `MAX_SOCKET_PATH`.
     */
    _controlPath(peer) {
        const digest = (0, crypto_1.createHash)('sha256').update(peer.raw).digest('hex').slice(0, 12);
        return path.join(this._controlDir, `ss-${digest}`);
    }
    _ensureControlDir() {
        // 0o700: the control socket is a live authenticated channel to the peer.
        try {
            fs.mkdirSync(this._controlDir, { recursive: true, mode: 0o700 });
        }
        catch { /* exists */ }
    }
    _recordFailure(peer, err) {
        const prev = this._failures.get(peer.raw);
        const count = (prev?.count ?? 0) + 1;
        const width = Math.min(exports.BACKOFF_BASE_MS * 2 ** (count - 1), exports.BACKOFF_CAP_MS);
        this._failures.set(peer.raw, {
            count,
            retryAt: this._now() + width,
            reason: err instanceof Error ? err.message : String(err),
        });
    }
}
exports.SshRunner = SshRunner;
