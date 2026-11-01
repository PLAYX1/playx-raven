import { secp256k1 as curve, schnorr as bip340 } from "@noble/curves/secp256k1";
// Desktop adapter for vendored phone core (not a vendored file). Only the calls the vendored files use:
// public key, ECDH x-coordinate (NIP-44, core/talk/nip44.ts) and BIP340 (core/talk/event.ts, core/wallet-link/link.ts).
export const secp256k1 = {
  pointFromScalar(key: Uint8Array, compressed: boolean): Uint8Array | null {
    try { return curve.getPublicKey(key, compressed); } catch { return null; }
  },
  /** Shared point x (32 bytes), as the phone backend returns. */
  ecdh(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
    return curve.getSharedSecret(privateKey, peerPublicKey, true).subarray(1, 33);
  },
};
export const schnorr = {
  sign: (hash: Uint8Array, key: Uint8Array): Uint8Array => bip340.sign(hash, key),
  verify: (hash: Uint8Array, pub: Uint8Array, sig: Uint8Array): boolean => { try { return bip340.verify(sig, hash, pub); } catch { return false; } },
};
