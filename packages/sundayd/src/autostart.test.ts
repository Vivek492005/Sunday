import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autostartDisableHint,
  autostartEnableHint,
  autostartTarget,
  generateAutostartEntry,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsTaskXml,
  installAutostart,
  uninstallAutostart,
} from './autostart.js';

const SPEC = { execPath: '/opt/sunday/sundayd/dist/cli.js', nodePath: '/usr/bin/node' };

describe('generateSystemdUnit', () => {
  it('contains the socket-mode command line', () => {
    const unit = generateSystemdUnit(SPEC);
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/sunday/sundayd/dist/cli.js" --socket');
    expect(unit).toContain('sundayd.sock');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=on-failure');
  });

  it('uses a custom socket path when given', () => {
    const unit = generateSystemdUnit({ ...SPEC, socketPath: '/tmp/custom.sock' });
    expect(unit).toContain('/tmp/custom.sock');
  });
});

describe('generateLaunchdPlist', () => {
  it('is a valid plist with RunAtLoad and KeepAlive', () => {
    const plist = generateLaunchdPlist(SPEC);
    expect(plist).toContain('<string>com.sunday.sundayd</string>');
    expect(plist).toContain('<string>--socket</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    // Clean exit (idle shutdown) must not trigger a relaunch.
    expect(plist).toContain('<key>SuccessfulExit</key>');
  });

  it('escapes XML special chars', () => {
    const plist = generateLaunchdPlist({ execPath: '/a&b/c<d>.js', nodePath: '/usr/bin/node' });
    expect(plist).toContain('/a&amp;b/c&lt;d&gt;.js');
  });
});

describe('generateWindowsTaskXml', () => {
  it('is a Task Scheduler XML with a logon trigger', () => {
    const xml = generateWindowsTaskXml(SPEC);
    expect(xml).toContain('http://schemas.microsoft.com/windows/2004/02/mit/task');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('sundayd-');
    expect(xml).toContain('--socket');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });
});

describe('generateAutostartEntry', () => {
  it('dispatches per platform', () => {
    expect(generateAutostartEntry('linux', SPEC)).toContain('[Unit]');
    expect(generateAutostartEntry('darwin', SPEC)).toContain('com.sunday.sundayd');
    expect(generateAutostartEntry('win32', SPEC)).toContain('<Task');
  });
});

describe('autostartTarget', () => {
  it('returns platform-appropriate paths', () => {
    expect(autostartTarget('linux', '/home/u').path).toBe(
      join('/home/u', '.config', 'systemd', 'user', 'sundayd.service'),
    );
    expect(autostartTarget('darwin', '/home/u').path).toBe(
      join('/home/u', 'Library', 'LaunchAgents', 'com.sunday.sundayd.plist'),
    );
    expect(autostartTarget('win32', '/home/u').path).toBe(
      join('/home/u', '.sunday', 'sundayd-autostart.xml'),
    );
  });
});

describe('install/uninstall (temp HOME — never touches the real system)', () => {
  it('writes and removes the entry', () => {
    const home = mkdtempSync(join(tmpdir(), 'sunday-autostart-'));
    const target = installAutostart('linux', SPEC, home);
    expect(existsSync(target.path)).toBe(true);
    const text = readFileSync(target.path, 'utf8');
    expect(text).toContain('ExecStart=');
    expect(uninstallAutostart('linux', home)).toBe(true);
    expect(existsSync(target.path)).toBe(false);
    // Second uninstall is a no-op.
    expect(uninstallAutostart('linux', home)).toBe(false);
  });
});

describe('hints', () => {
  it('enable/disable hints name the right commands', () => {
    const linux = autostartTarget('linux', '/home/u');
    expect(autostartEnableHint('linux', linux)).toContain('systemctl --user enable --now sundayd.service');
    expect(autostartDisableHint('linux', linux)).toContain('systemctl --user disable --now sundayd.service');
    const mac = autostartTarget('darwin', '/home/u');
    expect(autostartEnableHint('darwin', mac)).toContain('launchctl load');
    const win = autostartTarget('win32', '/home/u');
    expect(autostartEnableHint('win32', win)).toContain('schtasks /Create');
  });
});
