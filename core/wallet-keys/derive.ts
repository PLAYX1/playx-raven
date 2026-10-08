import { HDKey } from '@scure/bip32';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '../crypto-backend';
import { bytesToHex } from '../playx-asset-proof/crypto';
import { encodeBase58Check } from '../wallet-offline/base58check';

// SLIP-44 coin type 175 는 Ravencoin 이므로 BIP44 mainnet 경로는 m/44'/175'/account'/change/index 이다.
export const RAVENCOIN_BIP44_MAINNET_PATH = "m/44'/175'/0'/0/i";
const RVN_P2PKH_VERSION = 0x3c;

export type DerivedAddress = {
  address: string;
  publicKey: string;
};

export type AccountHandle = {
  accountIndex: number;
  xpub: string;
  deriveAddress(opts: { change: 0 | 1; index: number }): DerivedAddress;
};

export function deriveAccount(seed: Uint8Array, accountIndex: number): AccountHandle {
  assertIndex(accountIndex, 'accountIndex');
  const root = master(seed);
  const account = root.derive(accountPath(accountIndex));
  const xpub = account.publicExtendedKey;
  const publicAccount = HDKey.fromExtendedKey(xpub);
  account.wipePrivateData();
  root.wipePrivateData();

  return {
    accountIndex,
    xpub,
    deriveAddress: (opts) => addressFromPublicKey(publicAccount.derive(`m/${childPath(opts.change, opts.index)}`).publicKey),
  };
}

export function deriveAddress(
  seed: Uint8Array,
  opts: { change: 0 | 1; index: number; accountIndex?: number },
): DerivedAddress {
  const privateKey = derivePrivateKeyOnly(seed, opts);
  try {
    const publicKey = secp256k1.pointFromScalar(privateKey, true);
    if (!publicKey) throw new Error('공개키 파생에 실패했습니다');
    return addressFromPublicKey(publicKey);
  } finally { privateKey.fill(0); }
}

export function derivePrivateKeyOnly(
  seed: Uint8Array,
  opts: { change: 0 | 1; index: number; accountIndex?: number },
): Uint8Array {
  const accountIndex = opts.accountIndex ?? 0;
  assertIndex(accountIndex, 'accountIndex');
  assertChange(opts.change);
  assertIndex(opts.index, 'index');
  const root = master(seed);
  const child = root.derive(`${accountPath(accountIndex)}/${opts.change}/${opts.index}`);
  try {
    const privateKey = child.privateKey;
    if (!privateKey) throw new Error('개인키 파생에 실패했습니다');
    return Uint8Array.from(privateKey);
  } finally { child.wipePrivateData(); root.wipePrivateData(); }
}

function master(seed: Uint8Array): HDKey {
  if (!(seed instanceof Uint8Array) || seed.length < 16) {
    throw new Error('시드는 16바이트 이상의 Uint8Array 여야 합니다');
  }
  return HDKey.fromMasterSeed(seed);
}

function accountPath(accountIndex: number): string {
  return `m/44'/175'/${accountIndex}'`;
}

function childPath(change: 0 | 1, index: number): string {
  assertChange(change);
  assertIndex(index, 'index');
  return `${change}/${index}`;
}

function addressFromPublicKey(publicKey: Uint8Array | null): DerivedAddress {
  if (!publicKey || publicKey.length !== 33) throw new Error('압축 공개키 파생에 실패했습니다');
  const hash160 = ripemd160(sha256(publicKey));
  return {
    address: encodeBase58Check(RVN_P2PKH_VERSION, hash160),
    publicKey: bytesToHex(publicKey),
  };
}

function assertChange(change: number): asserts change is 0 | 1 {
  if (change !== 0 && change !== 1) throw new Error('change 는 0 또는 1 이어야 합니다');
}

function assertIndex(index: number, label: string) {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`${label} 는 0 이상 hardened 경계 미만의 정수여야 합니다`);
  }
}
