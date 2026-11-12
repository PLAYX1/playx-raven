/*
 * 폰에서 보낸 게임 올리기 — 데스크탑 쪽 일꾼. (2026-11-13, 대표 승인 「짝 맺은 폰에서 게임 올리기」)
 *
 * 폰(가게 주인 · 봉인 통로 /api/admin/arcade-upload)이 파일을 조각으로 보내면 러스트(arcade_phone.rs)가 받아 검사하고 일감으로 쌓는다.
 * 이 파일은 그 일감을 몇 초마다 집어서 「게임 올리기」 화면과 **같은 길**로 올린다:
 *   폴더 검사(checkFolder — 화면과 같은 규칙) → 일반 판매자면 runOpenUpload(arcade-open.ts, 0 RVN · 체인 거래 없음) → 결과를 폰에 알림.
 * 🔴 열쇠는 이 컴퓨터를 떠나지 않는다 — 폰은 글과 파일만 보낸다. 서명은 노드(판매자 주소)·러스트(겉봉투)에서.
 * 🔴 확인 칸의 자리:
 *   · 일반 판매자(0 RVN · 돈이 안 나감): 폰 화면에서 주인이 「읽었어요」 + 기기 잠금 확인을 지나야 보낸다. 지갑이 잠겨 있으면 여기서 멈추고
 *     「컴퓨터에서 지갑 열기」를 기다린다(needs-desktop).
 *   · 확인 판매자(RVLT/<가게> 아래 · RVN 소각): 폰 확인만으로는 태우지 않는다. 일감은 needs-desktop 으로 두고, 이 컴퓨터 「게임 올리기」 화면이
 *     받은 폴더·글을 채워 연다 → 소각액이 적힌 같은 확인 칸에서 사람이 「읽었어요」·「올리기」를 눌러야 나간다.
 */
import { checkFolder, entryCandidates, idFromTag, scanOf, type FolderScan } from "./arcade-upload-rules";
import { runOpenUpload, type OpenStep } from "./arcade-open";
import type { ArcadeGenre } from "../core/creator/arcade-product";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type PhoneMeta = { title: string; description?: string; genre: ArcadeGenre; priceSats: string; minutes: number; tag: string; mode: "open" | "shop"; shop?: string; entry?: string };
export type PhoneJob = { id: string; status: "queued" | "needs-desktop"; meta: PhoneMeta; scan: unknown };
export type PhoneDeps = {
  invoke: Invoke;
  /** 판매 주소(화면과 같은 localStorage rv-arcade-seller). 없으면 새 주소를 만들어 기억한다. */
  sellerStore?: { get(): string; set(v: string): void };
  /** 데스크탑 쪽에서 사람이 해야 할 일이 생기면(지갑 열기 · 가게 이름 확인) — 알림 띠를 그린다. */
  onNeedsDesktop?: (job: PhoneJob, why: "locked" | "shop") => void;
  /** 한 바퀴 돌았는데 사람이 할 일이 하나도 없을 때(알림 띠 지우기). */
  onClear?: () => void;
  /** 다 올렸을 때(장터 목록 새로 읽기 등). */
  onDone?: (job: PhoneJob, docCid: string) => void;
};

const SELLER_KEY = "rv-arcade-seller";
const localSeller = { get: () => { try { return localStorage.getItem(SELLER_KEY) || ""; } catch { return ""; } }, set: (v: string) => { try { localStorage.setItem(SELLER_KEY, v); } catch { /* 없어도 된다 */ } } };
const STEP_SAY: Record<OpenStep, string> = { pin: "게임 폴더를 IPFS 에 올리는 중", sign: "상품 문서에 서명하는 중", doc: "상품 문서를 IPFS 에 올리는 중", listing: "알림 쪽지를 공개 릴레이에 올리는 중", done: "" };

const report = (invoke: Invoke, id: string, status: string, step: string, message: string, result: unknown = null) =>
  invoke("arcade_phone_report", { id, status, step, message, result }).catch(() => { /* 일감이 사라졌으면 그만 */ });

/** 받은 폴더 검사 — 화면과 같은 checkFolder. 시작 파일은 폰이 적은 것, 없으면 첫 후보. */
export function phoneJobCheck(job: PhoneJob): { scan: FolderScan; entry: string; problems: string[] } | { scan: null; entry: ""; problems: string[] } {
  const scan = scanOf(job.scan);
  if (!scan || !scan.files.length) return { scan: null, entry: "", problems: ["받은 폴더를 읽지 못했어요."] };
  const entry = job.meta.entry && scan.files.some((f) => f.path === job.meta.entry) ? job.meta.entry : (entryCandidates(scan.files)[0] ?? "");
  const c = checkFolder(scan, entry || null);
  return { scan, entry, problems: c.problems.map((p) => p.say) };
}

/** 일감 하나. 돌려주는 값 = 그 일감의 마지막 상태(시험용). */
export async function processPhoneJob(deps: PhoneDeps, job: PhoneJob): Promise<"done" | "failed" | "rejected" | "needs-desktop"> {
  const { invoke } = deps;
  const c = phoneJobCheck(job);
  if (!c.scan || c.problems.length) { await report(invoke, job.id, "rejected", "check", c.problems.join(" · ")); return "rejected"; }
  if (job.meta.mode === "shop") {
    // 🔴 RVN 이 태워지는 길 — 폰 확인으로 끝내지 않는다. 이 컴퓨터 화면의 확인 칸으로 넘긴다.
    if (job.status !== "needs-desktop") await report(invoke, job.id, "needs-desktop", "confirm-shop", "가게 이름으로 올리기는 컴퓨터 화면에서 소각액을 확인하고 눌러야 해요.");
    deps.onNeedsDesktop?.(job, "shop");
    return "needs-desktop";
  }
  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  if (lock?.encrypted && !lock?.unlocked) {
    if (job.status !== "needs-desktop") await report(invoke, job.id, "needs-desktop", "unlock", "컴퓨터에서 지갑을 열어 주세요. 열면 바로 이어서 올려요.");
    deps.onNeedsDesktop?.(job, "locked");
    return "needs-desktop";
  }
  const store = deps.sellerStore ?? localSeller;
  try {
    await invoke("arcade_phone_take", { id: job.id }); // 받은 폴더를 「고른 폴더」로 — arcade_pin_folder 가 다시 재서 files 와 같을 때만 붙잡는다
    await report(invoke, job.id, "working", "start", "");
    let seller = store.get();
    if (!seller) { seller = String(await invoke<string>("new_address", { label: "arcade" })); store.set(seller); }
    const m = job.meta;
    const r = await runOpenUpload(invoke, {
      files: c.scan.files, id: idFromTag(m.tag), version: 1, title: m.title.trim(), description: m.description ?? "", priceSats: m.priceSats,
      seller, payTo: seller, entry: c.entry, minutes: m.minutes, genre: m.genre,
    }, (st) => { if (STEP_SAY[st]) void report(invoke, job.id, "working", st, STEP_SAY[st]); });
    await report(invoke, job.id, "done", "done", "올렸어요. 몇 분 안에 장터에 「일반 판매자」로 보여요.", { docCid: r.docCid, key: r.key, id: r.listing.id });
    deps.onDone?.(job, r.docCid);
    return "done";
  } catch (e) {
    await report(invoke, job.id, "failed", "error", String((e as Error)?.message ?? e).slice(0, 300));
    return "failed";
  }
}

/** 몇 초마다 일감을 본다. 한 번에 하나씩(앞 일이 끝나야 다음). 멈추려면 stop(). */
export function startPhoneUploads(deps: PhoneDeps, everyMs = 4000): { stop(): void; tick(): Promise<void> } {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const jobs = await deps.invoke<PhoneJob[]>("arcade_phone_jobs").catch(() => [] as PhoneJob[]);
      let waiting = 0;
      for (const j of Array.isArray(jobs) ? jobs : []) { if (stopped) break; if ((await processPhoneJob(deps, j)) === "needs-desktop") waiting++; }
      if (!waiting) deps.onClear?.();
    } finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), everyMs);
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}
