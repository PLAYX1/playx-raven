// Explicit destructive TEST MODE only; restores the owned source in finally.
// Never run concurrently with a build/release. It should exit 1 for the mutant.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const path = root + 'src-tauri/src/companion.rs';
const before = readFileSync(path, 'utf8');
const guard = 'if txid(raw)? != hash';
if (before.split(guard).length !== 2) throw Error('Expected one transaction-hash guard');
mkdirSync(root + 'artifacts/claude-desktop-ux', { recursive: true });
let result;
try {
  writeFileSync(path, before.replace(guard, 'if false /* intentional test mutant: removed previous transaction hash binding */'));
  result = spawnSync('cargo', ['test', '--offline', '--lib', 'companion::tests::previous_transaction_is_verified_against_actual_bytes', '--', '--exact', '--test-threads=1'], { cwd: root + 'src-tauri', encoding: 'utf8', timeout: 120000 });
} finally { writeFileSync(path, before); }
const output = (result?.stdout ?? '') + (result?.stderr ?? '');
writeFileSync(root + 'artifacts/claude-desktop-ux/native-mutant-red.txt', output);
if (!output.includes('A different transaction hash must not be accepted') || result.status === 0) throw Error('The deliberate mutant did not fail for the intended behavior');
console.error('EXPECTED RED: deleted hash binding rejected by semantic native test; source restored byte-for-byte. Cargo status ' + result.status);
process.exit(1);
