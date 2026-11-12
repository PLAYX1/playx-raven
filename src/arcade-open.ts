/*
 * 오락실 「일반 판매자」 올리기 길 — 0 RVN · 체인 거래 없음. 화면(arcade-upload.ts)과 폰 연결 올리기(arcade-phone-upload.ts)가 같은 함수를 쓴다. (2026-11-13, 대표 승인)
 *
 * 순서: 폴더 붙잡기(arcade_pin_folder — 고른/받은 폴더를 다시 재서 files 와 같을 때만) → 상품 문서 본문(assetName 없음)
 *   → 노드 signmessage(판매자 주소) → attachArcadeSignature 로 다시 확인 → 문서 붙잡기(ipfs_add_file) → 겉봉투 공개키(arcade_listing_pubkey)
 *   → 알림 쪽지 안쪽 서명(signmessage, 문구 = core arcadeListingMessage) → 되살린 주소 = 판매자인지 확인 → 올리기(arcade_listing_publish).
 * 🔴 열쇠는 이 컴퓨터를 떠나지 않는다: 서명은 노드(지갑 주소)와 러스트(겉봉투)에서. 이 파일은 순서와 확인만.
 * 🔴 「공개」(IPFS·릴레이)는 사람이 확인한 뒤에 부른다 — 부르는 쪽이 확인 칸을 지나야 한다.
 */
import { arcadeSigningMessage, attachArcadeSignature, encodeArcadeProduct, recoverArcadeSigner, type ArcadeGenre } from "../core/creator/arcade-product";
import { arcadeListingContent, arcadeListingMessage, type ArcadeListingFields } from "../core/creator/arcade-listing";
import { buildBody } from "./arcade-upload-rules";
import type { ArcadeFile } from "../core/creator/arcade-product";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type OpenStep = "pin" | "sign" | "doc" | "listing" | "done";
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const nowSec = () => Math.floor(Date.now() / 1000);

/** 알림 쪽지 하나 올리기(올림·고치기·내리기 공통). 안쪽 서명이 판매자 주소로 되살아나야 보낸다. */
export async function publishListing(invoke: Invoke, f: Omit<ArcadeListingFields, "at"> & { at?: number }): Promise<ArcadeListingFields> {
  const fields: ArcadeListingFields = { ...f, at: f.at ?? nowSec() };
  const npub = String(await invoke<string>("arcade_listing_pubkey"));
  if (!/^[a-f0-9]{64}$/.test(npub)) throw new Error("arcade-listing: pubkey");
  const message = arcadeListingMessage(fields, npub);
  const signed = await invoke<any>("sign_message", { address: fields.seller, message, passphrase: null });
  const sig = String(signed?.signature ?? "");
  if (recoverArcadeSigner(message, sig) !== fields.seller) throw new Error("arcade-listing: signature");
  await invoke("arcade_listing_publish", { content: arcadeListingContent(fields, sig) });
  return fields;
}

export type OpenUploadInput = {
  files: ArcadeFile[]; id: string; version: number; title: string; description: string; priceSats: string;
  seller: string; payTo: string; entry: string; minutes: number; genre: ArcadeGenre;
};
export type OpenUploadResult = { key: string; docCid: string; docHash: string; folderCid: string; listing: ArcadeListingFields };

/** 일반 판매자 게임 올리기 전체. 단계마다 onStep. 실패하면 그 자리에서 던진다(앞 단계의 IPFS 붙잡기는 남는다 — 공개 쪽지는 마지막). */
export async function runOpenUpload(invoke: Invoke, d: OpenUploadInput, onStep: (s: OpenStep) => void = () => {}): Promise<OpenUploadResult> {
  onStep("pin");
  const pinned = await invoke<any>("arcade_pin_folder", { expect: d.files });
  const folderCid = String(pinned?.cid ?? "");
  const body = buildBody({ ...d, cid: folderCid, assetName: "" });
  onStep("sign");
  const signed = await invoke<any>("sign_message", { address: d.seller, message: arcadeSigningMessage(body), passphrase: null });
  const v = attachArcadeSignature(body, String(signed?.signature ?? "")); // 서명이 seller 로 되살아나야 통과
  onStep("doc");
  const added = await invoke<any>("ipfs_add_file", { file: { name: "product.json", bytes: Array.from(encodeArcadeProduct(v.doc)) } });
  const docCid = String(added?.cid ?? "");
  if (!CID_V0.test(docCid)) throw new Error("arcade-open: doc-cid");
  onStep("listing");
  const listing = await publishListing(invoke, { seller: v.doc.seller, id: v.doc.id, version: v.doc.version, docCid, docHash: v.docHash, state: "open" });
  onStep("done");
  return { key: v.key, docCid, docHash: v.docHash, folderCid, listing };
}
