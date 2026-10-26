import { burnCheck, checkCreatorAssetName, nameConflicts, type NameNeighbor } from '../core/creator/asset-name';
import { atomsToRvn } from '../core/creator/bytes';
import { CONTENT_TYPES, SCRIPT_NOTICE } from '../core/creator/limits';
import { REAL_MAINNET_ISSUE_ENABLED, TEST_CHAINS, costPlan, precheck, type PublishInput } from '../core/creator/publish';

/*
 * 끌어놓기 발행의 두 순수 부품: (1) 상태 머신, (2) 안전 장치 점검 칩.
 *
 * 🔴 안전 장치는 마법사(creator-publish.ts)와 하나도 다르지 않다. 사람 눈에 칩 몇 개로 줄여 보일 뿐이고,
 *    「발행」을 누른 뒤에는 core planIssue(최종 판정)가 같은 것을 한 번 더 본다 — 둘 중 하나라도 막으면 발행하지 않는다.
 *      파일 자동 점검(core precheck/checkFiles) · 이름 규칙 · 이름 충돌·사칭 경고 · 체인 중복 조회(확인 불가 = 막힘)
 *      · 소각액 대조(확인 불가 = 표시, 불일치 = 막힘) · 붙여 넣은 CID 가 받아지는지(못 받으면 막힘)
 *      · 메인넷 스위치(꺼짐 = 시험망 외 막힘) · 잔액(모자라면 막힘)
 */

/* ── (1) 상태 머신 ───────────────────────────────────────────────────── */

export type DropState = 'idle' | 'detecting' | 'ask' | 'preview' | 'confirm' | 'publishing' | 'done' | 'blocked';
export type DropEvent =
  | 'drop' | 'pick' | 'paste'         // 무언가 들어왔다 → 알아보기
  | 'detected' | 'unsure' | 'answer'   // 알아봄 / 한 가지 물어야 함 / 대답
  | 'edit'                             // 미리보기에서 고침(상태 유지)
  | 'publish' | 'cancel' | 'confirm'   // 발행 누름 → 확인 창 / 취소 / 확인
  | 'blocked' | 'unblocked'            // 점검이 막힘 / 풀림
  | 'failed' | 'issued'                // 올리기·발행 실패(이어하기 가능) / 완료
  | 'reset' | 'resume';                // 처음으로 / 저장한 초안 열기

const T: Readonly<Record<DropState, Partial<Record<DropEvent, DropState>>>> = Object.freeze({
  idle: { drop: 'detecting', pick: 'detecting', paste: 'detecting', resume: 'preview' },
  detecting: { detected: 'preview', unsure: 'ask', failed: 'idle', reset: 'idle', blocked: 'blocked' },
  ask: { answer: 'preview', reset: 'idle', drop: 'detecting', pick: 'detecting', paste: 'detecting' },
  preview: { edit: 'preview', publish: 'confirm', blocked: 'blocked', drop: 'detecting', pick: 'detecting', paste: 'detecting', reset: 'idle', answer: 'preview' },
  blocked: { edit: 'blocked', unblocked: 'preview', drop: 'detecting', pick: 'detecting', paste: 'detecting', reset: 'idle' },
  confirm: { cancel: 'preview', confirm: 'publishing', blocked: 'blocked' },
  // 발행 중에는 새로 놓은 것을 받지 않는다(덮어쓰지 않는다). 실패하면 미리보기로 — 올린 파일은 캐시로 이어한다.
  publishing: { failed: 'preview', issued: 'done', blocked: 'blocked' },
  done: { reset: 'idle', drop: 'detecting', pick: 'detecting', paste: 'detecting' },
});
/** 다음 상태. 받지 않는 사건이면 지금 상태 그대로(무시). */
export const nextState = (s: DropState, e: DropEvent): DropState => T[s][e] ?? s;
export const acceptsDrop = (s: DropState) => T[s].drop !== undefined;
export const DROP_TRANSITIONS = T;

/* ── (2) 안전 장치 칩 ────────────────────────────────────────────────── */

export type ChipStatus = 'pass' | 'warn' | 'block';
export type Chip = { id: 'paused' | 'files' | 'info' | 'name' | 'lookalike' | 'chain-name' | 'burn' | 'cid' | 'network' | 'balance' | 'runs-code'; status: ChipStatus; say: string; next?: string };

export type GateInput = {
  input: PublishInput;
  /** 체인 중복 조회: true 있음 · false 비어 있음 · null 확인 불가 · 'checking' 조회 중. */
  nameTaken: boolean | null | 'checking';
  neighbors: readonly NameNeighbor[];
  chain: string;
  /** 체인에서 읽은 소각액(지금은 읽는 RPC 가 없어 늘 null). */
  chainBurnRvn: number | null;
  balanceAtoms: bigint | null;
  /** 붙여 넣은 CID 들이 받아지는가(없으면 빈 배열). */
  pastedCids: Array<{ cid: string; alive: boolean | null }>;
  realMainnetEnabled?: boolean;
  now?: number;
  /** 붙여 넣은 상품 정보(매니페스트)가 이미 서명 확인됐다 — 파일 점검 대신 그 결과를 쓴다(파일 CID 는 pastedCids 로 본다). */
  prepublished?: { asset: string } | null;
};

/** 종류별 칸 문제(마법사 ③ 단계와 같은 기준) — 원인 → 다음 행동. */
export function detailProblems(inp: PublishInput, now: number): string[] {
  const p: string[] = [], d = inp.details as unknown as Record<string, unknown>, n = (k: string) => d[k] as number;
  if (inp.title.trim().length > 80) p.push('제목이 80자를 넘어요 → 줄여 주세요.');
  if (inp.description.trim().length > 2000) p.push('설명이 2000자를 넘어요 → 줄여 주세요.');
  if (inp.priceAtoms === 'invalid') p.push('가격이 숫자가 아니에요 → 예: 20 또는 12.5');
  if (inp.type === 'music' && !(n('previewEndMs') > n('previewStartMs') + 999 && n('previewEndMs') - n('previewStartMs') <= 60_000)) p.push('미리듣기 구간이 이상해요 → 1초 이상 60초 이하로 정해 주세요.');
  if (inp.type === 'book' && !d.bookFile) p.push('책 파일(PDF·EPUB)이 없어요 → 책 파일을 놓아 주세요.');
  if (inp.type === 'book' && d.previewFile && !(n('previewPages') >= 1 && n('previewPages') <= 50)) p.push('미리보기 쪽수가 이상해요 → 1~50 사이로 적어 주세요.');
  if (inp.type === 'ticket') {
    if (!d.eventName || !d.venue) p.push('행사 이름·장소가 비어 있어요 → 고급에서 적어 주세요.');
    if (!d.startsAt) p.push('행사 시작 날짜·시각이 없어요 → 고급에서 골라 주세요.');
    else if (Date.parse(d.startsAt as string) <= now) p.push('행사 시작이 이미 지났어요 → 앞으로의 날짜를 골라 주세요.');
    if (!(n('quantity') >= 1 && n('quantity') <= 100000)) p.push('판매 수량이 이상해요 → 1 이상 적어 주세요.');
    if (!d.refundPolicy || !d.contact) p.push('환불 규정·연락처가 비어 있어요 → 고급에서 적어 주세요.');
  }
  if (inp.type === 'digital' && !d.label) p.push('상품 종류 한 줄이 비어 있어요 → 예: 그림 모음');
  if (inp.type === 'game' && !d.entry) p.push('여는 HTML 파일이 없어요 → index.html 이 든 폴더를 놓아 주세요.');
  return p;
}

/** 점검 칩 전부 + 발행 가능 여부. 칩 하나라도 block 이면 발행 단추를 잠근다. */
export function dropGates(g: GateInput): { chips: Chip[]; canPublish: boolean; blockers: Chip[] } {
  const chips: Chip[] = [], inp = g.input;
  if (g.prepublished) {
    chips.push({ id: 'files', status: 'pass', say: '이미 올린 상품 정보예요 — 형식·서명을 확인했어요.' });
    return finish(g, chips, inp, true);
  }
  const { check, problems } = precheck(inp);
  const fileProblems = check.problems.map(p => (p.path ? `${p.path}: ` : '') + p.say);
  const other = problems.filter(p => !fileProblems.includes(p));
  chips.push(fileProblems.length
    ? { id: 'files', status: 'block', say: `파일 ${fileProblems.length}곳이 안 맞아요: ${fileProblems[0]}`, next: '그 파일을 빼거나 바꿔서 다시 놓아 주세요.' }
    : check.warnings.length
      ? { id: 'files', status: 'warn', say: `파일 ${check.files.length}개 통과 · 주의 ${check.warnings.length}개: ${check.warnings[0].say}` }
      : { id: 'files', status: 'pass', say: `파일 ${check.files.length}개 모두 통과` });
  if (CONTENT_TYPES[inp.type].runsCode) chips.push({ id: 'runs-code', status: 'warn', say: SCRIPT_NOTICE });

  const name = checkCreatorAssetName(inp.asset, inp.prefix, { type: inp.type });
  chips.push(name.problems.length ? { id: 'name', status: 'block', say: name.problems[0], next: '고급 → 이름에서 제안된 이름을 누르거나 고쳐 주세요.' } : { id: 'name', status: 'pass', say: `이름 ${inp.asset}` });
  const info = [...other.filter(p => !name.problems.includes(p)), ...detailProblems(inp, g.now ?? Date.now())];
  if (info.length) chips.push({ id: 'info', status: 'block', say: info[0], next: '고급에서 고쳐 주세요.' });

  return finish(g, chips, inp, false);
}

function finish(g: GateInput, chips: Chip[], inp: PublishInput, pre: boolean): { chips: Chip[]; canPublish: boolean; blockers: Chip[] } {
  const name = checkCreatorAssetName(inp.asset, inp.prefix, { type: inp.type });
  if (pre) chips.push(name.problems.length ? { id: 'name', status: 'block', say: name.problems[0] } : { id: 'name', status: 'pass', say: `이름 ${inp.asset}` });
  const conflict = nameConflicts(inp.asset, inp.title, g.neighbors, inp.prefix);
  const lookalike = conflict.say.filter(s => !s.startsWith('이 이름은 이미'));
  if (lookalike.length) chips.push({ id: 'lookalike', status: 'warn', say: lookalike.join(' ') });

  const taken = conflict.taken ? true : g.nameTaken;
  chips.push(taken === 'checking' ? { id: 'chain-name', status: 'block', say: '체인에 같은 이름이 있는지 조회하는 중…' }
    : taken === true ? { id: 'chain-name', status: 'block', say: '이미 있는 이름이에요. 자산 이름은 영구라 다시 쓸 수 없어요.', next: '다른 이름을 골라 주세요.' }
    : taken === null ? { id: 'chain-name', status: 'block', say: '이 이름이 체인에 이미 있는지 확인 불가 — 노드에 묻지 못했어요.', next: '노드가 켜지고 동기화된 뒤 「다시 조회」를 눌러 주세요.' }
    : { id: 'chain-name', status: 'pass', say: '이름이 비어 있어요(노드에 물어 확인).' });

  const burn = burnCheck(name.kind, g.chainBurnRvn);
  chips.push(burn.status === 'mismatch' ? { id: 'burn', status: 'block', say: burn.say }
    : burn.status === 'unverifiable' ? { id: 'burn', status: 'warn', say: `소각액 ${burn.rvn} RVN — 체인과 대조 확인 불가(저장소에 적힌 값).` }
    : { id: 'burn', status: 'pass', say: `소각액 ${burn.rvn} RVN — 체인 값과 같아요.` });

  for (const c of g.pastedCids) {
    chips.push(c.alive === true ? { id: 'cid', status: 'pass', say: `${c.cid.slice(0, 10)}… 받아져요.` }
      : { id: 'cid', status: 'block', say: `${c.cid.slice(0, 10)}… ${c.alive === null ? '받아지는지 확인 중…' : '지금 받을 수 없어요 — 받아지지 않는 주소로는 팔 수 없어요.'}`, next: c.alive === null ? undefined : '그 파일을 가진 컴퓨터·IPFS 를 켜 두고 다시 붙여 넣거나, 파일을 직접 놓아 주세요.' });
  }

  const test = TEST_CHAINS.has(g.chain), live = g.realMainnetEnabled ?? REAL_MAINNET_ISSUE_ENABLED;
  chips.push(test ? { id: 'network', status: 'pass', say: `시험망(${g.chain}) — 실제 돈이 아니에요.` }
    : g.chain === 'main' && live ? { id: 'network', status: 'warn', say: '메인넷 — 실제 RVN 이 소각돼요.' }
    : g.chain === 'main' ? { id: 'network', status: 'block', say: '실제 발행은 아직 꺼져 있어요(대표 결정 대기). 시험망에서만 발행할 수 있어요.' }
    : { id: 'network', status: 'block', say: `네트워크를 알 수 없어요(${g.chain}).`, next: '노드가 켜질 때까지 기다려 주세요.' });

  const cost = costPlan({ burnRvn: burn.rvn, networkFeeAtoms: null, balanceAtoms: g.balanceAtoms });
  chips.push(cost.enough === false ? { id: 'balance', status: 'block', say: `잔액이 ${atomsToRvn(cost.shortAtoms)} RVN 모자라요.`, next: '「받기」 화면의 내 주소로 RVN 을 받은 뒤 다시 확인해 주세요.' }
    : cost.enough === null ? { id: 'balance', status: 'warn', say: '잔액을 아직 확인하지 못했어요.' }
    : { id: 'balance', status: 'pass', say: `잔액 충분(필요 ${atomsToRvn(cost.totalAtoms)} RVN)` });

  const blockers = chips.filter(c => c.status === 'block');
  return { chips, canPublish: blockers.length === 0, blockers };
}
