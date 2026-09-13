// Synthetic registry/shortcut fixtures only. Never executes an installer or app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
let nsis = read('src-tauri/installer/nsis-ravenvault.nsi');
const wix = read('src-tauri/installer/wix-ravenvault.wxs');
if (process.argv.includes('--mutant-registry')) nsis = nsis.replace('!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"', '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"');
if (process.argv.includes('--mutant-shortcut')) nsis = nsis.replace('  ${If} $0 = 1\n    ${If} ${FileExists}', '  ${If} 1 = 1\n    ${If} ${FileExists}');
const compiler = JSON.parse(read('node_modules/@tauri-apps/cli/package.json'));
assert.equal(compiler.version, '2.11.4', 'Review vendored templates before changing the Tauri CLI');
assert.equal(config.productName, 'RavenVault Desktop');
assert.equal(config.identifier, 'se.erci.ex.playx.raven');
assert.equal(config.bundle.windows.nsis.template, 'installer/nsis-ravenvault.nsi');
assert.equal(config.bundle.windows.wix.template, 'installer/wix-ravenvault.wxs');
// Tauri CLI 2.11.4's documented legacy default: UUIDv5(DNS,
// "<productName>.exe.app.x64"). Pin the original value across the visible rename.
const legacyGuidBytes = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
  .update('PLAY X Raven.exe.app.x64').digest().subarray(0, 16);
legacyGuidBytes[6] = (legacyGuidBytes[6] & 15) | 80; legacyGuidBytes[8] = (legacyGuidBytes[8] & 63) | 128;
const legacyHex = legacyGuidBytes.toString('hex');
const legacyGuid = [legacyHex.slice(0, 8), legacyHex.slice(8, 12), legacyHex.slice(12, 16), legacyHex.slice(16, 20), legacyHex.slice(20)].join('-');
assert.equal(config.bundle.windows.wix.upgradeCode?.toLowerCase(), legacyGuid, 'MSI upgrade GUID must remain the original PLAY X Raven identity');

const tokens = line => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
const constants = Object.fromEntries([...nsis.matchAll(/^!define (\w+) "([^"]*)"/gm)].map(m => [m[1], m[2]]));
for (const [key, value] of Object.entries(constants)) constants[key] = value.replaceAll('{{product_name}}', config.productName)
  .replaceAll('{{manufacturer}}', config.identifier.split('.')[1]).replaceAll('{{bundle_id}}', config.identifier)
  .replaceAll('{{main_binary_name}}', 'playx-raven');
const win = value => path.win32.normalize(value).toLowerCase();
const reg = (root, key, name = '') => `${root.toUpperCase()}|${win(key)}|${name.toLowerCase()}`;
const functionBody = name => {
  const body = nsis.match(new RegExp(`Function ${name}\\n([\\s\\S]*?)FunctionEnd`))?.[1];
  assert.ok(body, `Missing actual NSIS function ${name}`); return body;
};
const macro = nsis.match(/!macro RavenVaultMigrateLegacyShortcut SHORTCUTDIR\n([\s\S]*?)!macroend/)?.[1];
assert.ok(macro, 'Actual target-checked migration macro is required');

// Execute only the small, explicitly supported NSIS instruction subset used by
// the actual compatibility paths. Unknown instructions fail instead of passing.
// This checks decisions against synthetic data; it is not a Windows installation.
function run(code, options = {}) {
  const vars = { INSTDIR: 'C:\\Synthetic\\Default', OldMainBinaryName: 'PLAY X Raven.exe', ...options.vars };
  const defines = { ...constants, ...options.defines }, registry = options.registry ?? new Map();
  const records = options.records ?? [], files = options.files ?? new Map(), stack = [], branches = [], actions = [];
  const resolve = value => {
    for (let n = 0; n < 10 && /\$\{\w+\}/.test(value); n++) value = value.replace(/\$\{(\w+)\}/g, (_, key) => defines[key] ?? fail(`Unknown constant ${key}`));
    return value.replace(/\$(R[0-9]|[0-9]|[A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => String(vars[name] ?? ''));
  };
  const variable = value => value.slice(1);
  let errors = false;
  function condition(args) {
    if (args[0] === '${Errors}') return errors;
    if (args[0] === '${FileExists}') return files.has(win(resolve(args[1])));
    const [left, op, right] = args.map(resolve);
    if (op === '=' || op === '==') return left === right;
    if (op === '!=') return left !== right;
    fail('Unsupported condition: ' + args.join(' '));
  }
  const lines = code.split('\n').map(s => s.split(' ;')[0].trim()).filter(s => s && !s.startsWith(';'));
  const labels = new Map(lines.flatMap((s, n) => s.endsWith(':') ? [[s.slice(0, -1), n]] : []));
  let ip = 0, steps = 0;
  function jump(target) {
    if (!target || target === '0') { ip++; return; }
    if (/^[+-]\d+$/.test(target)) { ip += Number(target); return; }
    assert.ok(labels.has(target), 'Missing jump label ' + target); ip = labels.get(target);
  }
  while (ip < lines.length) {
    if (++steps > 1000) fail('NSIS fixture exceeded its instruction budget');
    const line = lines[ip], [command, ...args] = tokens(line);
    const active = branches.every(v => v.active);
    if (command === '${If}' || command === '${IfNot}') {
      const value = active && (command === '${IfNot}' ? !condition(args) : condition(args));
      branches.push({ parent: active, active: value, matched: value }); ip++; continue;
    }
    if (command === '${AndIf}') {
      const branch = branches.at(-1); assert.ok(branch); branch.active = branch.active && condition(args); branch.matched = branch.active; ip++; continue;
    }
    if (command === '${Else}') {
      const branch = branches.at(-1); assert.ok(branch); branch.active = branch.parent && !branch.matched; ip++; continue;
    }
    if (command === '${EndIf}') { assert.ok(branches.pop()); ip++; continue; }
    if (!active || line.endsWith(':')) { ip++; continue; }
    switch (command) {
      case 'ReadRegStr': {
        const hive = args[1] === 'SHCTX' ? options.context ?? 'HKCU' : args[1];
        vars[variable(args[0])] = registry.get(reg(hive, resolve(args[2]), resolve(args[3]))) ?? ''; break;
      }
      case 'EnumRegKey': vars[variable(args[0])] = records[Number(resolve(args[3]))] ?? ''; break;
      case 'IntOp': assert.equal(args[2], '+'); vars[variable(args[0])] = String(Number(resolve(args[1])) + Number(resolve(args[3]))); break;
      case 'StrCpy': vars[variable(args[0])] = resolve(args[1]); break;
      case 'StrCmp': jump(resolve(args[0]) === resolve(args[1]) ? args[2] : args[3]); continue;
      case 'Goto': jump(args[0]); continue;
      case '${StrCase}': assert.equal(args[2], 'L'); vars[variable(args[0])] = resolve(args[1]).toLowerCase(); break;
      case '${StrLoc}': vars[variable(args[0])] = String(resolve(args[1]).indexOf(resolve(args[2]))); break;
      case 'Return': ip = lines.length; continue;
      case 'Pop': vars[variable(args[0])] = stack.pop(); break;
      case 'ClearErrors': errors = false; break;
      case 'Rename': {
        const from = win(resolve(args[0])), to = win(resolve(args[1]));
        if (!files.has(from) || files.has(to)) errors = true;
        else { files.set(to, files.get(from)); files.delete(from); actions.push(['rename', from, to]); }
        break;
      }
      case 'Delete': { const name = win(resolve(args[0])); files.delete(name); actions.push(['delete', name]); break; }
      case '!insertmacro': {
        const [name, ...values] = args, [file, target] = values.map(resolve);
        if (name === 'IsShortcutTarget') stack.push(files.has(win(file)) && win(files.get(win(file))) === win(target) ? '1' : '0');
        else if (name === 'SetShortcutTarget') { assert.ok(files.has(win(file))); files.set(win(file), target); actions.push(['retarget', win(file), win(target)]); }
        else if (name === 'SetLnkAppUserModelId' || name === 'UnpinShortcut') actions.push([name, win(file)]);
        else fail('Unexpected helper ' + name);
        break;
      }
      default: fail('Unsupported NSIS instruction: ' + line);
    }
    ip++;
  }
  assert.equal(branches.length, 0); return { vars, files, actions, resolve };
}
function fail(message) { throw new Error(message); }

const legacyKey = 'Software\\erci\\PLAY X Raven';
const customDir = 'D:\\Synthetic Apps\\Original Raven';
for (const context of ['HKCU', 'HKLM']) {
  const registry = new Map([[reg(context, legacyKey), customDir]]);
  const result = run(functionBody('RestorePreviousInstallLocation'), { registry, context });
  assert.equal(result.vars.INSTDIR, customDir, 'Existing custom NSIS path must survive the display rename');
  assert.equal(result.resolve('${UNINSTKEY}'), 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PLAY X Raven');
  assert.equal(result.resolve('${MANUPRODUCTKEY}'), legacyKey);
}
assert.equal(run(functionBody('RestorePreviousInstallLocation')).vars.INSTDIR, 'C:\\Synthetic\\Default');
assert.match(nsis, /WriteRegStr SHCTX "\$\{UNINSTKEY\}" "DisplayName" "\$\{PRODUCTNAME\}"/);
assert.match(nsis, /WriteRegStr SHCTX "\$\{MANUPRODUCTKEY\}" "" \$INSTDIR/);
console.log('PASS actual NSIS restore code preserves legacy HKCU/HKLM paths and uninstall identity while displaying RavenVault');

const detection = 'StrCpy $0 0\n' + nsis.match(/wix_loop:\n[\s\S]*?wix_loop_done:/)[0] + '\nReturn\ncompare_version:\nReturn';
const uninstall = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
for (const name of ['PLAY X Raven', 'RavenVault Desktop']) {
  const registry = new Map();
  const rows = [['other', name, 'another publisher'], ['other-name', 'Unrelated app', 'erci'], ['ours', name, 'erci']];
  rows.forEach(([key, display, publisher]) => {
    registry.set(reg('HKLM', uninstall + '\\' + key, 'DisplayName'), display);
    registry.set(reg('HKLM', uninstall + '\\' + key, 'Publisher'), publisher);
    registry.set(reg('HKLM', uninstall + '\\' + key, 'UninstallString'), 'MsiExec.exe /X{00000000-0000-0000-0000-000000000000}');
  });
  const result = run(detection, { registry, records: rows.map(r => r[0]) });
  assert.equal(result.vars.WixMode, '1'); assert.equal(result.vars.R6, uninstall + '\\ours');
}
assert.equal(run(detection).vars.WixMode, undefined);
const leave = functionBody('PageLeaveReinstall');
assert.ok(leave.indexOf('${If} $WixMode = 1') < leave.indexOf('${If} $UpdateMode = 1'), 'MSI migration must retain upstream uninstall-before-update order');
assert.match(leave, /ExecWait '\$R1' \$0/);
console.log('PASS actual MSI discovery loop accepts old/new names with matching publisher; original uninstall ordering retained');

const shortcutDir = 'C:\\Synthetic Start Menu';
const oldLink = win(path.win32.join(shortcutDir, 'PLAY X Raven.lnk'));
const newLink = win(path.win32.join(shortcutDir, 'RavenVault Desktop.lnk'));
const target = path.win32.join(customDir, 'playx-raven.exe');
const migrate = entries => run(macro, { files: new Map(entries), vars: { INSTDIR: customDir }, defines: { SHORTCUTDIR: shortcutDir } });
const renamed = migrate([[oldLink, target]]);
assert.equal(renamed.files.has(oldLink), false); assert.equal(renamed.files.get(newLink), target);
assert.ok(renamed.actions.some(a => a[0] === 'rename'));
const oldBinary = migrate([[oldLink, path.win32.join(customDir, 'PLAY X Raven.exe')]]);
assert.equal(oldBinary.files.get(newLink), target);
const unrelated = migrate([[oldLink, 'C:\\Other App\\other.exe']]);
assert.equal(unrelated.files.get(oldLink), 'C:\\Other App\\other.exe'); assert.deepEqual(unrelated.actions, []);
assert.equal(migrate([]).files.size, 0, 'Never recreate shortcuts removed by the user');
const occupied = migrate([[oldLink, target], [newLink, 'C:\\Other App\\other.exe']]);
assert.equal(occupied.files.get(newLink), 'C:\\Other App\\other.exe'); assert.equal(occupied.files.get(oldLink), target); assert.deepEqual(occupied.actions, []);
const duplicate = migrate([[oldLink, target], [newLink, target]]);
assert.equal(duplicate.files.has(oldLink), false); assert.equal(duplicate.files.get(newLink), target);
assert.match(functionBody('CreateOrUpdateStartMenuShortcut'), /RavenVaultMigrateLegacyShortcut "\$SMPROGRAMS"/);
assert.match(functionBody('CreateOrUpdateDesktopShortcut'), /RavenVaultMigrateLegacyShortcut "\$DESKTOP"/);
console.log('PASS actual shortcut macro only migrates this install; unrelated targets, occupied names and removed shortcuts preserved');

const installProperty = wix.match(/<Property Id="INSTALLDIR">([\s\S]*?)<\/Property>/)[1];
const searches = [...installProperty.matchAll(/<RegistrySearch\b([^>]+)\/>/g)].map(match => Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(v => [v[1], v[2]])));
assert.equal(searches.length, 2);
function wixInstallDir(registry) {
  let location;
  for (const search of searches) {
    const key = search.Key.replaceAll('{{manufacturer}}', 'erci').replaceAll('{{product_name}}', config.productName);
    const found = registry.get(reg(search.Root, key, search.Name ?? '')); if (found) location = found;
  }
  return location;
}
assert.equal(wixInstallDir(new Map([[reg('HKCU', legacyKey, 'InstallDir'), customDir]])), customDir);
assert.equal(wixInstallDir(new Map([[reg('HKCU', legacyKey), 'C:\\Synthetic NSIS'], [reg('HKCU', legacyKey, 'InstallDir'), customDir]])), customDir);
assert.equal(wixInstallDir(new Map([[reg('HKCU', legacyKey), 'C:\\Synthetic NSIS']])), 'C:\\Synthetic NSIS');
assert.ok(!wix.includes('Key="Software\\\\{{manufacturer}}\\\\{{product_name}}"'));
assert.equal(wix.match(/Key="Software\\\\\{\{manufacturer\}\}\\\\PLAY X Raven"/g)?.length, 6);
assert.match(wix, /Name="\{\{product_name\}\}"/); assert.match(wix, /UpgradeCode="\{\{upgrade_code\}\}"/);
console.log('PASS actual WiX registry searches preserve custom MSI path and original MSI-over-NSIS priority; all six saved/search keys stable');

// Reconstruct the untouched official source. No unreviewed template change can
// hide behind the compatibility checks above; network is unnecessary for tests.
let restored = nsis.split('\n').slice(4).join('\n');
restored = restored.replace('; RavenVault: preserve the original Windows installation identity across display renames.\n!define LEGACYPRODUCTNAME "PLAY X Raven"\n', '');
restored = restored.replace('!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACYPRODUCTNAME}"', '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"');
restored = restored.replace('!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"', '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"');
restored = restored.replace('    ; RavenVault: recognize either display name, with the unchanged publisher.\n    StrCmp "$R1" "${MANUFACTURER}" 0 wix_loop\n    StrCmp "$R0" "${PRODUCTNAME}" wix_product_match\n    StrCmp "$R0" "${LEGACYPRODUCTNAME}" 0 wix_loop\n    wix_product_match:', '    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop');
restored = restored.replace(/; RavenVault compatibility: rename only a shortcut[\s\S]*?!macroend\n\n/, '');
restored = restored.replaceAll('  !insertmacro RavenVaultMigrateLegacyShortcut "$SMPROGRAMS\\$AppStartMenuFolder"\n', '').replaceAll('  !insertmacro RavenVaultMigrateLegacyShortcut "$SMPROGRAMS"\n', '').replaceAll('  !insertmacro RavenVaultMigrateLegacyShortcut "$DESKTOP"\n', '');
const digest = value => createHash('sha256').update(value).digest('hex');
assert.equal(digest(restored), '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079', 'Unexpected NSIS change beyond the documented patch');
const restoredWix = wix.split('\n').slice(5).join('\n').replaceAll('Key="Software\\\\{{manufacturer}}\\\\PLAY X Raven"', 'Key="Software\\\\{{manufacturer}}\\\\{{product_name}}"');
assert.equal(digest(restoredWix), 'e371a01628a06730828f9bd24111feacb8bec53c250ccec4b46df756fe0a0198', 'Unexpected WiX change beyond legacy registry keys');
assert.equal(digest(read('src-tauri/installer/LICENSE-MIT')), '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d');
console.log('PASS unmodified portions exactly match the official CLI 2.11.4 source hashes and MIT license');

if (process.argv.includes('--compile')) {
  // Compile only; never launch the produced PE. The full Windows bundle remains
  // CI's responsibility. The toolkit helpers are compile-time fixture stubs.
  const temporary = mkdtempSync(path.join(root, 'src-tauri/installer/.syntax-'));
  try {
    const fixture = [
      'Unicode true', '!include "LogicLib.nsh"', '!include "StrFunc.nsh"', '${StrCase}', '${StrLoc}',
      'Name "Synthetic identity syntax check"', 'OutFile "synthetic-installer.exe"', 'RequestExecutionLevel user',
      '!define PRODUCTNAME "RavenVault Desktop"', '!define LEGACYPRODUCTNAME "PLAY X Raven"', '!define MAINBINARYNAME "playx-raven"',
      '!define MANUFACTURER "erci"', '!define MANUKEY "Software\\${MANUFACTURER}"', '!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"',
      'Var OldMainBinaryName', 'Var WixMode',
      '!macro IsShortcutTarget A B\nPush 0\n!macroend', '!macro SetShortcutTarget A B\n!macroend',
      '!macro UnpinShortcut A\n!macroend', '!macro SetLnkAppUserModelId A\n!macroend',
      '!macro RavenVaultMigrateLegacyShortcut SHORTCUTDIR\n' + macro + '!macroend',
      'Function FixtureMSI\n' + detection + '\nFunctionEnd',
      'Function RestorePreviousInstallLocation\n' + functionBody('RestorePreviousInstallLocation') + 'FunctionEnd',
      'Section "Synthetic"\nCall RestorePreviousInstallLocation\nCall FixtureMSI\n!insertmacro RavenVaultMigrateLegacyShortcut "$TEMP\\Synthetic"\nSectionEnd',
    ].join('\n');
    const input = path.join(temporary, 'fixture.nsi'); writeFileSync(input, fixture);
    execFileSync('makensis', ['-V2', input], { cwd: temporary, encoding: 'utf8', stdio: 'pipe' });
    console.log('PASS makensis compiled the actual migration macro and lookup code; synthetic installer was never executed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
