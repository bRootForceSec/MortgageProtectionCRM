import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Start at login. Windows and Mac use Electron's login-item setting; Linux has no such setting,
// so we write the standard ~/.config/autostart entry ourselves.

export interface LoginItem {
  get(): boolean;
  set(on: boolean): void;
}

export function linuxAutostartFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'mortgage-protection-crm.desktop');
}

/** The command that starts this app: the AppImage when run from one, otherwise the Electron binary. */
export function linuxLaunchCommand(env: NodeJS.ProcessEnv, execPath: string, appPath: string | null) {
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  if (env.APPIMAGE) return `${q(env.APPIMAGE)} --hidden`;
  return appPath ? `${q(execPath)} ${q(appPath)} --hidden` : `${q(execPath)} --hidden`;
}

export function linuxLoginItem(command: string, file = linuxAutostartFile()): LoginItem {
  return {
    get: () => fs.existsSync(file),
    set(on) {
      if (!on) return fs.rmSync(file, { force: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        ['[Desktop Entry]', 'Type=Application', 'Name=Mortgage Protection CRM', `Exec=${command}`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join('\n'),
      );
    },
  };
}
