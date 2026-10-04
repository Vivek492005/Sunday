/**
 * Stage 4: autostart installation for the per-user sundayd daemon.
 *
 * `sundayd --install-autostart` writes a platform-appropriate autostart
 * entry that launches `sundayd --socket <well-known-path>` at login:
 *
 * - Linux:   systemd user unit  → `~/.config/systemd/user/sundayd.service`
 * - macOS:   launchd agent      → `~/Library/LaunchAgents/com.sunday.sundayd.plist`
 * - Windows: scheduled task XML → printed for `schtasks /Create /XML` (plus
 *            a `HKCU\...\Run` registry alternative documented in DAEMON.md)
 *
 * This module only *generates* the files; the CLI writes them. Tests assert
 * on the generated text — no systemd/launchd/schtasks is ever touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sharedDaemonSocketPath } from '@sunday/protocol';

export type AutostartPlatform = 'linux' | 'darwin' | 'win32';

export function autostartPlatform(platform: NodeJS.Platform = process.platform): AutostartPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

export interface AutostartTarget {
  /** Human name, e.g. "systemd user unit". */
  kind: string;
  /** Absolute path the entry is written to (N/A for the Windows XML). */
  path: string;
}

/** Where the autostart entry lives for each platform. */
export function autostartTarget(
  platform: AutostartPlatform = autostartPlatform(),
  homeDir: string = os.homedir(),
): AutostartTarget {
  switch (platform) {
    case 'darwin':
      return {
        kind: 'launchd agent',
        path: path.join(homeDir, 'Library', 'LaunchAgents', 'com.sunday.sundayd.plist'),
      };
    case 'win32':
      return {
        kind: 'scheduled task XML (import with schtasks)',
        path: path.join(homeDir, '.sunday', 'sundayd-autostart.xml'),
      };
    default:
      return {
        kind: 'systemd user unit',
        path: path.join(homeDir, '.config', 'systemd', 'user', 'sundayd.service'),
      };
  }
}

export interface AutostartSpec {
  /** Absolute path to the sundayd entrypoint (node script). */
  execPath: string;
  /** Socket path the daemon should serve. Defaults to the well-known per-user path. */
  socketPath?: string;
  /** Node executable. Defaults to `process.execPath`. */
  nodePath?: string;
}

function quoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * systemd user unit. `WantedBy=default.target` starts it at login;
 * `Restart=on-failure` recovers from crashes but never masks the idle
 * shutdown (exit 0 is a clean exit, not a failure).
 */
export function generateSystemdUnit(spec: AutostartSpec): string {
  const node = spec.nodePath ?? process.execPath;
  const socket = spec.socketPath ?? sharedDaemonSocketPath({ platform: 'linux' });
  return `[Unit]
Description=Sunday per-user agent daemon (sundayd)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${quoteArg(spec.execPath)} --socket ${quoteArg(socket)}
Restart=on-failure
RestartSec=5
# Keep the daemon's files owner-only.
UMask=0077

[Install]
WantedBy=default.target
`;
}

/**
 * launchd agent plist. `RunAtLoad` starts it at login; `KeepAlive` with
 * `SuccessfulExit=false` restarts on crashes but respects the idle
 * shutdown (clean exit 0 is not restarted).
 */
export function generateLaunchdPlist(spec: AutostartSpec): string {
  const node = spec.nodePath ?? process.execPath;
  const socket = spec.socketPath ?? sharedDaemonSocketPath({ platform: 'darwin' });
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sunday.sundayd</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(spec.execPath)}</string>
    <string>--socket</string>
    <string>${esc(socket)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(path.join(os.homedir(), '.sunday', 'sundayd.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(os.homedir(), '.sunday', 'sundayd.log'))}</string>
</dict>
</plist>
`;
}

/**
 * Windows scheduled-task XML (Task Scheduler 1.3 schema). Import with:
 *
 *   schtasks /Create /TN "Sunday sundayd" /XML sundayd-autostart.xml /F
 *
 * Logon trigger, "run only when the user is logged on" (per-user daemon —
 * no elevation needed). The XML embeds the node + sundayd command line.
 */
export function generateWindowsTaskXml(spec: AutostartSpec): string {
  const node = spec.nodePath ?? process.execPath;
  const socket = spec.socketPath ?? sharedDaemonSocketPath({ platform: 'win32' });
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sunday per-user agent daemon (sundayd) — starts at logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(node)}</Command>
      <Arguments>${esc(`"${spec.execPath}" --socket "${socket}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Generate the autostart entry text for a platform. */
export function generateAutostartEntry(
  platform: AutostartPlatform,
  spec: AutostartSpec,
): string {
  switch (platform) {
    case 'darwin':
      return generateLaunchdPlist(spec);
    case 'win32':
      return generateWindowsTaskXml(spec);
    default:
      return generateSystemdUnit(spec);
  }
}

/** Post-install instructions printed by `--install-autostart`. */
export function autostartEnableHint(
  platform: AutostartPlatform,
  target: AutostartTarget,
): string {
  switch (platform) {
    case 'darwin':
      return `launchd agent written to ${target.path}\nEnable it with:\n  launchctl load ${target.path}`;
    case 'win32':
      return `Scheduled-task XML written to ${target.path}\nImport it with (PowerShell, as your user):\n  schtasks /Create /TN "Sunday sundayd" /XML "${target.path}" /F\nAlternative: add a REG_SZ value under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run (see docs/DAEMON.md).`;
    default:
      return `systemd user unit written to ${target.path}\nEnable it with:\n  systemctl --user daemon-reload && systemctl --user enable --now sundayd.service`;
  }
}

/** Post-uninstall instructions printed by `--uninstall-autostart`. */
export function autostartDisableHint(
  platform: AutostartPlatform,
  target: AutostartTarget,
): string {
  switch (platform) {
    case 'darwin':
      return `launchd agent removed from ${target.path}\nIf it was loaded, unload it with:\n  launchctl unload ~/Library/LaunchAgents/com.sunday.sundayd.plist`;
    case 'win32':
      return `Scheduled-task XML removed from ${target.path}\nIf it was imported, delete the task with:\n  schtasks /Delete /TN "Sunday sundayd" /F`;
    default:
      return `systemd user unit removed from ${target.path}\nIf it was enabled, disable it with:\n  systemctl --user disable --now sundayd.service`;
  }
}

/**
 * Write the autostart entry to its platform target path (creating parent
 * dirs). Returns the target. Owner-only permissions on POSIX.
 */
export function installAutostart(
  platform: AutostartPlatform = autostartPlatform(),
  spec: AutostartSpec,
  homeDir: string = os.homedir(),
): AutostartTarget {
  const target = autostartTarget(platform, homeDir);
  const text = generateAutostartEntry(platform, spec);
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, text, { mode: platform === 'win32' ? 0o666 : 0o600 });
  return target;
}

/**
 * Remove the autostart entry. Returns true when a file was removed.
 */
export function uninstallAutostart(
  platform: AutostartPlatform = autostartPlatform(),
  homeDir: string = os.homedir(),
): boolean {
  const target = autostartTarget(platform, homeDir);
  try {
    fs.unlinkSync(target.path);
    return true;
  } catch {
    return false;
  }
}
