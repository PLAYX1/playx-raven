import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
execFileSync(process.execPath,[fileURLToPath(new URL('./build-wallet-integrity.mjs',import.meta.url)),'--check'],{stdio:'pipe'});
