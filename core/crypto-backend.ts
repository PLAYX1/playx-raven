import { secp256k1 as curve } from "@noble/curves/secp256k1";
export const secp256k1 = { pointFromScalar(key: Uint8Array, compressed: boolean): Uint8Array | null {
 try { return curve.getPublicKey(key, compressed); } catch { return null; }
} };
