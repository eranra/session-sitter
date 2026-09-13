import { describe, expect, it } from 'vitest';
import {
  discoverPeers,
  extractAuthorities,
  isSelfAddress,
  parseAuthority,
  stripWindowId,
} from '../remote/PeerDiscovery';

// The IDE records a remote window as `ssh-remote+<authority>`, where the authority is
// `user@host`. Two places carry it, and both are mined:
//
//   keys:   remote.tunnels.toRestore.ssh-remote+vpcuser@host.76044865
//   values: vscode-remote://ssh-remote%2Bvpcuser%40host/home/vpcuser/project
//
// The trailing `.76044865` is a window id, not part of the host. Stripping it is the one
// genuinely dangerous step: an IPv4 authority also ends in `.<digits>`, so a naive strip turns
// `eranra@192.168.50.16` into `eranra@192.168.50`.

/** Encode a connection record the way VS Code's Remote - SSH encodes its authority. */
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** Verbatim from a real state db: the authority of a VS Code window connected to olapevolve. */
const HEX_OLAPEVOLVE =
  '7b22686f73744e616d65223a226f6c617065766f6c76652e7670632e636c6f7564392e69626d2e636f6d22'
  + '2c2275736572223a2276706375736572227d';

describe('stripWindowId', () => {
  it('strips a long positive window id', () => {
    expect(stripWindowId('vpcuser@olapevolve.vpc.cloud9.ibm.com.76044865'))
      .toBe('vpcuser@olapevolve.vpc.cloud9.ibm.com');
  });

  it('strips a negative window id', () => {
    expect(stripWindowId('192.168.50.16.-628450726')).toBe('192.168.50.16');
  });

  it('leaves a bare IPv4 address alone', () => {
    // The regression this guards: `.16` is a final octet, not a window id.
    expect(stripWindowId('eranra@192.168.50.16')).toBe('eranra@192.168.50.16');
  });

  it('leaves an IPv4 authority with no user alone', () => {
    expect(stripWindowId('192.168.50.16')).toBe('192.168.50.16');
  });

  it('leaves a normal hostname alone', () => {
    expect(stripWindowId('vpcuser@olapevolve.vpc.cloud9.ibm.com'))
      .toBe('vpcuser@olapevolve.vpc.cloud9.ibm.com');
  });

  it('strips only one id segment', () => {
    expect(stripWindowId('user@host.example.com.428151645')).toBe('user@host.example.com');
  });
});

describe('parseAuthority', () => {
  it('splits user@host', () => {
    expect(parseAuthority('vpcuser@olapevolve.vpc.cloud9.ibm.com')).toEqual({
      user: 'vpcuser',
      host: 'olapevolve.vpc.cloud9.ibm.com',
      raw: 'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    });
  });

  it('rejects a bare host, which gives us no user to connect as', () => {
    expect(parseAuthority('192.168.50.16')).toBeNull();
    expect(parseAuthority('olapevolve.vpc.cloud9.ibm.com')).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(parseAuthority('')).toBeNull();
    expect(parseAuthority('@host')).toBeNull();
    expect(parseAuthority('user@')).toBeNull();
    expect(parseAuthority('a@b@c')).toBeNull();
  });

  // VS Code's Remote - SSH does not write `user@host` for a host it was given directly: it
  // hex-encodes a JSON connection record instead. Read off a real state db, the authority for
  // olapevolve is HEX_OLAPEVOLVE below, which decodes to
  // {"hostName":"olapevolve.vpc.cloud9.ibm.com","user":"vpcuser"}. Rejecting that form is what made
  // every VS Code remote window invisible to the panel while Bob's plain form kept working.
  it('decodes the hex-encoded JSON authority VS Code writes', () => {
    expect(parseAuthority(HEX_OLAPEVOLVE)).toEqual({
      user: 'vpcuser',
      host: 'olapevolve.vpc.cloud9.ibm.com',
      raw: 'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    });
  });

  it('decodes the hex form whatever order the JSON keys arrive in', () => {
    expect(parseAuthority(hex('{"user":"vpcuser","port":22,"hostName":"olap.ibm.com"}'))?.raw)
      .toBe('vpcuser@olap.ibm.com');
  });

  it('rejects a hex record with no user, same as a bare host', () => {
    // Guessing a username is a speculative SSH connection, which is exactly the traffic this
    // discovery must not create — so a record without one is no more usable than `host` alone.
    expect(parseAuthority(hex('{"hostName":"olap.ibm.com"}'))).toBeNull();
    expect(parseAuthority(hex('{"hostName":"olap.ibm.com","user":""}'))).toBeNull();
  });

  it('rejects hex that is not a connection record', () => {
    expect(parseAuthority(hex('not json at all'))).toBeNull();
    expect(parseAuthority(hex('{"hostName":"h","user":"u"'))).toBeNull(); // truncated JSON
    expect(parseAuthority('7b2268')).toBeNull();                          // too short to be one
    expect(parseAuthority('abcdef0123456789abcdef0123456789')).toBeNull(); // hex, but not JSON
  });

  it('still reads a plain hostname that happens to be all hex digits', () => {
    // `deadbeef` is a legal hostname and an even-length hex string. Decoding wins only when the
    // bytes really are a JSON record, so a host like this must not be swallowed by the hex branch
    // — and with no user it is rejected for that reason, not misread as a record.
    expect(parseAuthority('deadbeef')).toBeNull();
    expect(parseAuthority('u@deadbeef')?.host).toBe('deadbeef');
  });
});

describe('extractAuthorities', () => {
  it('mines the tunnel-restore key form', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+vpcuser@olapevolve.vpc.cloud9.ibm.com.76044865'];
    expect(extractAuthorities(keys, [])).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('mines the percent-encoded value form', () => {
    const values = ['vscode-remote://ssh-remote%2Bvpcuser%40olapevolve.vpc.cloud9.ibm.com/home/vpcuser/p'];
    expect(extractAuthorities([], values)).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('mines the plain value form', () => {
    const values = ['vscode-remote://ssh-remote+eranra@192.168.50.16/home/eranra/p'];
    expect(extractAuthorities([], values)).toEqual(['eranra@192.168.50.16']);
  });

  it('dedupes the same authority found in both places and both encodings', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+vpcuser@host.example.com.76044865'];
    const values = [
      'vscode-remote://ssh-remote%2Bvpcuser%40host.example.com/a',
      'vscode-remote://ssh-remote+vpcuser@host.example.com/b',
    ];
    expect(extractAuthorities(keys, values)).toEqual(['vpcuser@host.example.com']);
  });

  it('drops a suffixed duplicate when the clean form is also present', () => {
    // Belt-and-braces alongside stripWindowId: if both forms survive, keep the shorter.
    const values = [
      'ssh-remote+eranra@192.168.50.16',
      'ssh-remote+eranra@192.168.50.16.428151645',
    ];
    expect(extractAuthorities([], values)).toEqual(['eranra@192.168.50.16']);
  });

  it('ignores non-ssh remote authorities', () => {
    const values = ['vscode-remote://wsl+fedora/home/eranra/p', 'wsl+podman-machine-default'];
    expect(extractAuthorities([], values)).toEqual([]);
  });

  it('ignores authorities with no username', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+192.168.50.16.-628450726'];
    expect(extractAuthorities(keys, [])).toEqual([]);
  });

  it('returns several distinct peers sorted for stable output', () => {
    const values = [
      'ssh-remote+vpcuser@olapevolve.vpc.cloud9.ibm.com',
      'ssh-remote+eranra@192.168.50.16',
    ];
    expect(extractAuthorities([], values)).toEqual([
      'eranra@192.168.50.16',
      'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    ]);
  });

  it('survives junk input without throwing', () => {
    expect(extractAuthorities(['ssh-remote+'], ['ssh-remote%2B', 'ssh-remote+@'])).toEqual([]);
  });

  // The two forms below are copied from a real VS Code state db, for one remote window on
  // olapevolve: the key carries the host with no user, and the value carries the hex record that
  // does have one. Mining found both before this fix and could use neither, so the panel showed
  // nothing at all for a window the IDE was actively connected to.
  it('mines the hex-encoded JSON form VS Code records for a remote window', () => {
    const keys = [`ssh-remote+${'olapevolve.vpc.cloud9.ibm.com'}`];
    const values = [`[18:51:12] Resolving ssh-remote+${HEX_OLAPEVOLVE} created and cached`];
    expect(extractAuthorities(keys, values)).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('mines the percent-encoded hex form from a folder URI', () => {
    const values = [`vscode-remote://ssh-remote%2B${HEX_OLAPEVOLVE}/home/vpcuser/olap`];
    expect(extractAuthorities([], values)).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('dedupes a hex record against the plain form of the same peer', () => {
    const values = [
      `ssh-remote+${HEX_OLAPEVOLVE}`,
      'ssh-remote+vpcuser@olapevolve.vpc.cloud9.ibm.com',
    ];
    expect(extractAuthorities([], values)).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('strips a window id from a hex authority', () => {
    const keys = [`remote.tunnels.toRestore.ssh-remote+${HEX_OLAPEVOLVE}.76044865`];
    expect(extractAuthorities(keys, [])).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });
});

describe('discoverPeers', () => {
  const dbs = ['/mnt/c/Users/u/AppData/Roaming/IBM Bob/User/globalStorage/state.vscdb'];

  // Pin the local identity for every case that is not about self-detection. Otherwise these
  // assertions quietly depend on the addresses of whatever machine runs the suite: 192.168.50.16
  // is a real interface on the development box, so an unpinned fixture using it would be dropped
  // there and kept on CI.
  const notSelf = { localAddresses: [] as string[], localHostname: 'test-runner-host' };

  it('reads every state db it is given and unions the result', async () => {
    const peers = await discoverPeers({
      ...notSelf,
      findStateDbs: async () => [...dbs, '/other/state.vscdb'],
      readItemTable: async (p) => p === dbs[0]
        ? { keys: ['remote.tunnels.toRestore.ssh-remote+vpcuser@olap.ibm.com.76044865'], values: [] }
        : { keys: [], values: ['ssh-remote+eranra@192.168.50.16'] },
    });
    expect(peers.map(p => p.raw)).toEqual([
      'eranra@192.168.50.16',
      'vpcuser@olap.ibm.com',
    ]);
  });

  it('returns nothing when no state db is reachable', async () => {
    const peers = await discoverPeers({
      findStateDbs: async () => [],
      readItemTable: async () => { throw new Error('should not be called'); },
    });
    expect(peers).toEqual([]);
  });

  it('skips a db it cannot read instead of failing the whole pass', async () => {
    // The IDE holds these files open; one unreadable db must not hide the others.
    const peers = await discoverPeers({
      ...notSelf,
      findStateDbs: async () => ['/bad/state.vscdb', ...dbs],
      readItemTable: async (p) => {
        if (p === '/bad/state.vscdb') { throw new Error('database is locked'); }
        return { keys: [], values: ['ssh-remote+vpcuser@olap.ibm.com'] };
      },
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });

  it('excludes peers matching the local identity', async () => {
    const peers = await discoverPeers({
      findStateDbs: async () => dbs,
      readItemTable: async () => ({
        keys: [],
        values: ['ssh-remote+eranra@my-box', 'ssh-remote+vpcuser@olap.ibm.com'],
      }),
      isSelf: (p) => p.host === 'my-box',
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });

  it('discovers a VS Code remote window, whose authority is a hex record', async () => {
    // End to end over the exact rows a VS Code profile holds: no peer came out of this before,
    // which is the whole bug — Bob wrote `user@host` and was found, VS Code writes hex and was not.
    const peers = await discoverPeers({
      ...notSelf,
      findStateDbs: async () => ['/Users/u/Library/Application Support/Code/User/globalStorage/state.vscdb'],
      readItemTable: async () => ({
        keys: ['ssh-remote+olapevolve.vpc.cloud9.ibm.com'],
        values: [`vscode-remote://ssh-remote%2B${HEX_OLAPEVOLVE}/home/vpcuser/olap`],
      }),
    });
    expect(peers).toEqual([{
      user: 'vpcuser',
      host: 'olapevolve.vpc.cloud9.ibm.com',
      raw: 'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    }]);
  });

  it('drops this machine by default, without being told to', async () => {
    // The `isSelf` seam used to default to "nothing is ever me", so a machine that had recorded
    // its own LAN address as an ssh-remote target probed itself every pass. Observed for real:
    // 192.168.50.16 is one of this host's own interfaces, and because ssh to yourself has no
    // reason to hold a key for you, it failed on publickey and the panel reported the user's own
    // machine as unreachable forever. Self-detection cannot wait for the probe's machineId — that
    // needs the ssh that is failing.
    const peers = await discoverPeers({
      findStateDbs: async () => dbs,
      readItemTable: async () => ({
        keys: [],
        values: ['ssh-remote+eranra@192.168.50.16', 'ssh-remote+vpcuser@olap.ibm.com'],
      }),
      localAddresses: ['127.0.0.1', '192.168.50.16', '172.26.89.33'],
      localHostname: 'eranra-wsl',
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });
});

describe('isSelfAddress', () => {
  const local = { addresses: ['127.0.0.1', '192.168.50.16', '::1'], hostname: 'eranra-wsl.local' };

  it('matches an address bound to one of this host\'s interfaces', () => {
    expect(isSelfAddress('192.168.50.16', local)).toBe(true);
  });

  it('matches loopback by name and by address', () => {
    expect(isSelfAddress('localhost', local)).toBe(true);
    expect(isSelfAddress('127.0.0.1', local)).toBe(true);
    expect(isSelfAddress('::1', local)).toBe(true);
  });

  it('matches this host by name, full or short', () => {
    expect(isSelfAddress('eranra-wsl.local', local)).toBe(true);
    expect(isSelfAddress('eranra-wsl', local)).toBe(true);
    expect(isSelfAddress('ERANRA-WSL', local)).toBe(true);
  });

  it('does not match a real peer', () => {
    expect(isSelfAddress('olapevolve.vpc.cloud9.ibm.com', local)).toBe(false);
    expect(isSelfAddress('192.168.50.17', local)).toBe(false);
  });

  it('does not match a peer that merely shares our short name as a prefix', () => {
    // Substring matching here would silently hide a real machine, so the comparison is on
    // whole labels only.
    expect(isSelfAddress('eranra-wsl2', local)).toBe(false);
    expect(isSelfAddress('eranra-wsl.example.com', local)).toBe(false);
  });

  it('strips an IPv6 scope and zone brackets before comparing', () => {
    expect(isSelfAddress('[::1]', local)).toBe(true);
    expect(isSelfAddress('fe80::1%eth0', { addresses: ['fe80::1'], hostname: 'h' })).toBe(true);
  });
});
