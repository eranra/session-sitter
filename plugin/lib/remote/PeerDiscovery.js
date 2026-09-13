// GENERATED FILE — DO NOT EDIT.
// Compiled from src/remote/PeerDiscovery.ts by scripts/build-plugin-lib.js (`make plugin`).
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
exports.stripWindowId = stripWindowId;
exports.parseAuthority = parseAuthority;
exports.isSelfAddress = isSelfAddress;
exports.extractAuthorities = extractAuthorities;
exports.discoverPeers = discoverPeers;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const BobDatabase_1 = require("../BobDatabase");
/**
 * Remove a trailing IDE window-id segment from an authority.
 *
 * This is the one step here that can silently corrupt an address, because an IPv4 authority also
 * ends in `.<digits>`: stripping blindly turns `eranra@192.168.50.16` into `eranra@192.168.50`.
 *
 * The two are separable by shape. A window id is a signed 32-bit-ish integer — negative, or long.
 * A final IPv4 octet is at most 3 digits, and a hostname's last label is never all digits (no
 * numeric TLDs). So strip only when the last segment is negative or has 5+ digits, which no
 * octet and no TLD can be.
 */
function stripWindowId(authority) {
    return authority.replace(/\.(-\d+|\d{5,})$/, '');
}
/**
 * Read a hex-encoded JSON connection record, the form VS Code uses for a host given to it directly
 * rather than named in `~/.ssh/config`.
 *
 * Every gate here exists to keep an ordinary hostname out of this branch, because a hostname can
 * itself be valid hex — `deadbeef` is a legal label. So the bytes must be hex of even length, and
 * must decode to something that is actually a JSON object carrying both fields. Anything less
 * falls through to the `user@host` reading, where a bare host is rejected as it always was.
 *
 * A `port` in the record is deliberately ignored: `PeerAddress` is an ssh destination, and a
 * non-default port belongs in the user's ssh config, which is where `SshRunner` will pick it up.
 */
function parseHexRecord(authority) {
    if (authority.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(authority)) {
        return null;
    }
    const text = Buffer.from(authority, 'hex').toString('utf8');
    if (!text.startsWith('{')) {
        return null;
    }
    let record;
    try {
        record = JSON.parse(text);
    }
    catch {
        return null;
    }
    const host = typeof record.hostName === 'string' ? record.hostName.trim() : '';
    const user = typeof record.user === 'string' ? record.user.trim() : '';
    if (!host || !user) {
        return null;
    }
    return { user, host, raw: `${user}@${host}` };
}
/**
 * Split an authority into its parts, or return null when it is not usable.
 *
 * Accepts both shapes an IDE writes: `user@host`, and the hex-encoded JSON record described above.
 *
 * A bare host is rejected on purpose, in either shape. Without a username we would have to guess
 * one, and every wrong guess is a speculative SSH connection — exactly the traffic this feature
 * must not create.
 */
function parseAuthority(authority) {
    const parts = authority.split('@');
    // No separator is the hex record's shape as well as a bare host's, so it is the only case worth
    // decoding — and checking first keeps a real `user@host` on the cheap path.
    if (parts.length === 1) {
        return parseHexRecord(authority);
    }
    if (parts.length !== 2) {
        return null;
    }
    const [user, host] = parts;
    if (!user || !host) {
        return null;
    }
    return { user, host, raw: `${user}@${host}` };
}
/** Every address currently bound to a local interface. */
function localInterfaceAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list ?? []) {
            if (iface.address) {
                out.push(iface.address);
            }
        }
    }
    return out;
}
/** Normalise a host for comparison: lowercase, no brackets, no IPv6 zone. */
function normalizeHost(host) {
    return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}
/**
 * Is this authority really this machine?
 *
 * Worth stating why this cannot be left to the probe. `RemoteSessionSource` also compares the
 * `machineId` the probe reports against the local one — but that answer only arrives *after* a
 * successful SSH. An IDE routinely records this host's own LAN address as an ssh-remote target,
 * and a machine has no reason to hold an authorized key for itself, so probing yourself fails on
 * publickey. The probe's check therefore never runs, and the panel names the user's own machine as
 * unreachable, forever, every poll. Self-detection has to happen before the connection.
 *
 * Names are compared on whole labels, never as substrings: `eranra-wsl2` is a different machine
 * from `eranra-wsl`, and hiding a real peer is worse than probing one extra host.
 */
function isSelfAddress(host, opts = {}) {
    const h = normalizeHost(host);
    if (!h) {
        return false;
    }
    if (h === 'localhost' || h === 'localhost.localdomain') {
        return true;
    }
    const addresses = (opts.addresses ?? localInterfaceAddresses()).map(normalizeHost);
    if (addresses.includes(h)) {
        return true;
    }
    const hostname = normalizeHost(opts.hostname ?? os.hostname());
    if (h === hostname) {
        return true;
    }
    // A short name matches the host's own first label, and only as the whole authority.
    const short = hostname.split('.')[0];
    return short.length > 0 && h === short;
}
// Matches both encodings of the marker (`+` and `%2B`) and both encodings of the separator
// (`@` and `%40`), so one pattern covers the key form and the URI form.
const AUTHORITY_RE = /ssh-remote(?:\+|%2B)([A-Za-z0-9_.%@-]*)/g;
/**
 * Pull every distinct, usable peer authority out of raw ItemTable keys and values.
 *
 * Normalised to `user@host` on the way out, whichever shape it was recorded in. That is what makes
 * one machine one peer: the same host is routinely written both as a hex record and as plain
 * `user@host` in the same db, and emitting them verbatim would probe it twice and list it twice.
 *
 * Returned sorted so the peer list — and therefore the panel — is stable between passes.
 */
function extractAuthorities(keys, values) {
    const found = new Set();
    for (const text of [...keys, ...values]) {
        for (const m of text.matchAll(AUTHORITY_RE)) {
            let auth;
            try {
                auth = decodeURIComponent(m[1]);
            }
            catch {
                auth = m[1];
            }
            // A URI's authority ends at the path separator.
            auth = auth.split('/')[0];
            if (auth) {
                found.add(auth);
            }
        }
    }
    const stripped = new Set();
    for (const auth of found) {
        stripped.add(stripWindowId(auth));
    }
    // Belt and braces for stripWindowId: if a suffixed form somehow survives alongside its clean
    // form, keep only the clean one. Cheap, and it fails safe if the id heuristic ever misses.
    const out = new Set();
    for (const auth of stripped) {
        const shadowed = [...stripped].some(other => other !== auth && auth.startsWith(other + '.') && /^-?\d+$/.test(auth.slice(other.length + 1)));
        if (shadowed) {
            continue;
        }
        const parsed = parseAuthority(auth);
        if (parsed) {
            out.add(parsed.raw);
        }
    }
    return [...out].sort();
}
/** Read the `key`/`value` columns of an IDE state db. */
async function readItemTableViaSqlite(dbPath) {
    // Copy before reading. The IDE holds this file open, and reading it in place — especially over
    // a /mnt/c DrvFs mount — can fail on a lock or a WAL the reader cannot follow.
    const tmp = path.join(os.tmpdir(), `ss-state-${process.pid}-${Date.now()}.vscdb`);
    await fs.promises.copyFile(dbPath, tmp);
    try {
        const rows = await (0, BobDatabase_1.queryBobDb)(tmp, 'SELECT key, value FROM ItemTable');
        return {
            keys: rows.map(r => String(r.key ?? '')),
            values: rows.map(r => String(r.value ?? '')),
        };
    }
    finally {
        try {
            await fs.promises.unlink(tmp);
        }
        catch { /* best effort */ }
    }
}
/** Every directory an IDE might keep its user profile in, on this platform. */
function ideProfileRoots(homedir) {
    const roots = [];
    if (process.platform === 'darwin') {
        roots.push(path.join(homedir, 'Library', 'Application Support'));
    }
    else if (process.platform === 'win32') {
        roots.push(process.env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'));
    }
    else {
        roots.push(path.join(homedir, '.config'));
        // A WSL extension host can reach the Windows hub that launched it, and that is where the
        // authorities for *other* remotes live — the Linux side never sees them.
        for (const win of listWindowsUserProfiles()) {
            roots.push(path.join(win, 'AppData', 'Roaming'));
        }
    }
    return roots;
}
function listWindowsUserProfiles() {
    const skip = new Set(['Public', 'Default', 'Default User', 'All Users']);
    try {
        return fs.readdirSync('/mnt/c/Users')
            .filter(name => !skip.has(name))
            .map(name => path.join('/mnt/c/Users', name))
            .filter(p => { try {
            return fs.statSync(p).isDirectory();
        }
        catch {
            return false;
        } });
    }
    catch {
        return []; // not WSL, or no Windows drive mounted
    }
}
/** Locate each IDE's `User/globalStorage/state.vscdb` under every profile root. */
async function findStateDbsOnDisk(homedir = os.homedir()) {
    const out = [];
    for (const root of ideProfileRoots(homedir)) {
        let apps;
        try {
            apps = await fs.promises.readdir(root);
        }
        catch {
            continue;
        }
        for (const app of apps) {
            const db = path.join(root, app, 'User', 'globalStorage', 'state.vscdb');
            try {
                if ((await fs.promises.stat(db)).isFile()) {
                    out.push(db);
                }
            }
            catch { /* not an IDE profile */ }
        }
    }
    return out;
}
/**
 * Discover peer machines to pull sessions from. Local file reads only — no SSH.
 *
 * A state db that cannot be read is skipped rather than fatal: the IDE keeps these files open, so
 * one locked db must not hide the peers recorded in the others.
 */
async function discoverPeers(opts = {}) {
    const findStateDbs = opts.findStateDbs ?? (() => findStateDbsOnDisk(opts.homedir));
    const readItemTable = opts.readItemTable ?? readItemTableViaSqlite;
    const isSelf = opts.isSelf ?? ((p) => isSelfAddress(p.host, {
        addresses: opts.localAddresses,
        hostname: opts.localHostname,
    }));
    let dbs;
    try {
        dbs = await findStateDbs();
    }
    catch {
        return [];
    }
    const keys = [];
    const values = [];
    for (const db of dbs) {
        try {
            const table = await readItemTable(db);
            keys.push(...table.keys);
            values.push(...table.values);
        }
        catch { /* locked or not a state db — other dbs may still have peers */ }
    }
    return extractAuthorities(keys, values)
        .map(parseAuthority)
        .filter((p) => p !== null && !isSelf(p));
}
