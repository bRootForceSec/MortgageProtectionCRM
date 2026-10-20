// Prints the notes for a GitHub release: the changes since the previous release, then how to install.
// The app shows the "- " lines as "What's new".
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let previous = '';
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^');
} catch {
  // first release
}
const range = previous ? [`${previous}..HEAD`] : ['-30', 'HEAD'];
const changes = git('log', '--no-merges', '--format=%s', ...range).split('\n').filter(Boolean).slice(0, 30);

const lines = [
  previous ? `Changes since ${previous}:` : 'Changes:',
  '',
  ...(changes.length ? changes.map((c) => `- ${c}`) : ['- Small fixes']),
  '',
  '## Install',
  '',
  'Download the file for your computer below:',
  '',
  '- **Windows**: `…-win-x64.exe`. Windows will say "Windows protected your PC" the first time: click **More info**, then **Run anyway**.',
  '- **Mac**: `…-mac-arm64.dmg` for Apple-chip Macs (M1 and newer), `…-mac-x64.dmg` for older Intel Macs. Open the .dmg and drag the app to Applications. The first time you open it, the Mac blocks it: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.',
  '- **Linux**: `…-linux-x86_64.AppImage`. Make it executable (`chmod +x`) and run it.',
  '',
  'After the first install the app updates itself from this page.',
];
process.stdout.write(`${lines.join('\n')}\n`);
