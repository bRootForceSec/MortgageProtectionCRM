import { execFile } from 'node:child_process';

// Sends a number to your phone through KDE Connect (Fedora: `sudo dnf install kdeconnectd`, plus the
// KDE Connect app on the phone). The phone opens its dialer with the number filled in; you press call.
// Runs kdeconnect-cli directly with arguments (no shell), and only ever with a checked US number.

export interface KdeDevice {
  id: string;
  name: string;
  reachable: boolean;
}

type Runner = (cmd: string, args: string[]) => Promise<string>;

const run: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reject(new Error('KDE Connect is not installed on this computer (kdeconnect-cli was not found).'));
        return reject(new Error((stderr || e.message).toString().trim().split('\n')[0] || 'KDE Connect failed'));
      }
      resolve(stdout.toString());
    });
  });

export class KdeConnect {
  constructor(private runner: Runner = run, private cmd = 'kdeconnect-cli') {}

  /** Paired devices. `kdeconnect-cli -l --id-name-only` prints "<id> <name>" per line; -a limits to reachable ones. */
  async devices(): Promise<KdeDevice[]> {
    const [all, live] = await Promise.all([
      this.runner(this.cmd, ['-l', '--id-name-only']),
      this.runner(this.cmd, ['-a', '--id-only']).catch(() => ''),
    ]);
    const reachable = new Set(live.split('\n').map((l) => l.trim()).filter(Boolean));
    return all
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        const id = sp > 0 ? l.slice(0, sp) : l;
        return { id, name: sp > 0 ? l.slice(sp + 1) : l, reachable: reachable.has(id) };
      });
  }

  async dial(deviceId: string, e164: string) {
    if (!/^[\w-]{1,100}$/.test(deviceId)) throw new Error('choose your phone in Settings first');
    if (!/^\+1\d{10}$/.test(e164)) throw new Error('not a US phone number');
    await this.runner(this.cmd, ['-d', deviceId, '--share', `tel:${e164}`]);
  }
}
