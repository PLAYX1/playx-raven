/** Public derivation only; no wallet seed, private derivation or signing dependency. Lazy-loaded. */
import { HDKey } from '@scure/bip32';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase58Check } from '../wallet-offline/base58check';
export async function deriveSalesAddress(xpub: string, account: number, index: number): Promise<string> {
  if (!xpub.startsWith('xpub') || xpub.length > 120 || !Number.isSafeInteger(account) || account < 0 || account >= 0x80000000
    || !Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw Error('invalid-public-derivation');
  const key = HDKey.fromExtendedKey(xpub);
  if (key.privateKey || key.depth !== 3 || key.index !== account + 0x80000000) throw Error('account-xpub-required');
  const branch = key.deriveChild(0), child = branch.deriveChild(index);
  // Do not accept a library's skip-to-next-index fallback as the requested child.
  if (branch.index !== 0 || child.index !== index || !child.publicKey) throw Error('invalid-public-child');
  return encodeBase58Check(60, ripemd160(sha256(child.publicKey)));
}
