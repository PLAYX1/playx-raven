import { atomsToRvn, rvnToAtoms } from '../core/creator/bytes';
import { askNameTaken, nameTakenSettled } from './name-lookup';
import { ASSET_KIND_LETTER, assetPrefixFor, checkCreatorAssetName, nameConflicts, suggestNames, type NameNeighbor } from '../core/creator/asset-name';
import { CONTENT_TYPES, CONTENT_TYPE_IDS, SCRIPT_NOTICE, extOf, type ContentType, type FileInput } from '../core/creator/limits';
import { buildListingRequest } from '../core/creator/listing';
import { CreatorError, isRvnAddress, validateManifest, type CreatorManifest, type Details } from '../core/creator/manifest';
import { BOND_SAY, OPEN_MARKET_SALES_ENABLED, feeNotice, type FeeNoticeOptions } from '../core/creator/open-market';
import { MARKET_FEE_BPS_CEILING, type FeeSchedule } from '../core/creator/fee-schedule';
import { splitPrice } from '../core/game-registry/platform-fee';

/** 일정이 받을 수 있는 가장 높은 요율(코드 천장)로 나눠도 판매자 몫이 남는가 — 매니페스트 검사와 같은 기준. */
const splitsAtCeiling = (atoms: string) => { try { splitPrice(atoms, MARKET_FEE_BPS_CEILING); return true; } catch { return false; } };
import {
  REAL_MAINNET_ISSUE_ENABLED, checkPinHealth, costPlan, planIssue, precheck, publishContent,
  type CidProbe, type IssuePlan, type Issuer, type MessageSigner, type PinAdapter, type PinCache, type PublishInput, type PublishResult,
} from '../core/creator/publish';

/*
 * 데스크탑 「내 상품 올리기」 마법사(판매자 기능을 켠 사람에게만). 레이븐코인·IPFS 를 모르는 사람이 전문 용어 없이 끝낼 수 있게
 * 안내 → ①종류 ②파일 ③이름·설명·가격 ④자동 점검 ⑤드는 돈 ⑥올리기(이어하기) ⑦마지막 확인 ⑧완료 로 나눈다.
 * 규칙·검사·문구의 근거는 전부 core/creator(지갑 저장소에서 복사)에 있고 여기는 고르고·보여 주고·누르는 것만 한다.
 *
 * 바깥 세계와 닿는 곳은 전부 기존 명령이다:
 *   · 보관(pin): ipfs_add_file(CIDv0·pin) · 보관 확인: cid_alive · 서명: sign_message(노드 signmessage)
 *   · 등록: issue_asset — **시험망(test·regtest)에서만**. 메인넷은 REAL_MAINNET_ISSUE_ENABLED(대표 결정)가 켜야 열린다.
 *   · 잔액: wallet_balance · 받는 주소: receive_address·new_address · 이름 확인(체인 중복 조회): name_taken(노드 getassetdata) · 네트워크: node_status
 *   · 이름은 대표 확정 `RV.<종류글자>.<작품이름>` — 앞부분(RV.M. 등)은 고른 종류로 정해지고 사람은 작품 이름 칸만 적는다.
 * 시드·비밀번호·서명 문구를 로그로 남기지 않는다. 이어하기 저장(localStorage)에는 공개 정보(칸 값·CID·매니페스트)만 둔다 — 파일 바이트·비밀번호 없음.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function kuboPinAdapter(invoke: Invoke): PinAdapter {
  return {
    id: 'local-kubo', real: true,
    holder: '이 컴퓨터의 IPFS 보관함 — 이 컴퓨터가 꺼져 있거나 파일을 지우면 다른 사람이 못 받을 수 있어요',
    async add(name, bytes) {
      const r = await invoke<{ cid: string; size: number }>('ipfs_add_file', { file: { name: name.replace(/[\\/]/g, '_'), bytes: Array.from(bytes) } });
      return { cid: String(r?.cid ?? ''), size: Number(r?.size ?? -1) };
    },
  };
}

export function nodeSigner(invoke: Invoke, askPassword: () => Promise<string | null>): MessageSigner {
  return async (address, message) => {
    try {
      return String((await invoke<{ signature: string }>('sign_message', { address, message }))?.signature ?? '');
    } catch (e) {
      if (!/잠겨/.test(String(e))) throw e;
      let passphrase = await askPassword();
      if (!passphrase) throw new Error('비밀번호를 넣지 않아 서명하지 않았어요.');
      try { return String((await invoke<{ signature: string }>('sign_message', { address, message, passphrase }))?.signature ?? ''); }
      finally { passphrase = null; }
    }
  };
}

export function nodeIssuer(invoke: Invoke): Issuer {
  return {
    async issue(p) {
      const r = await invoke<{ txid?: string }>('issue_asset', { name: p.name, qty: p.qty, units: p.units, reissuable: p.reissuable, ipfsHash: p.ipfsHash, toAddress: null });
      const txid = String(r?.txid ?? '');
      if (!/^[a-f0-9]{64}$/.test(txid)) throw new Error('노드가 거래 번호를 돌려주지 않았어요. 지갑 내역을 확인해 주세요.');
      return { txid };
    },
  };
}
export const nodeProbe = (invoke: Invoke): CidProbe => async cid => (await invoke<boolean>('cid_alive', { cid, timeoutSecs: 20 })) === true;

/** 이어하기 저장 형식(공개 정보만). */
export const DRAFT_KEY = 'rv-creator-draft-v2';
export const MINE_KEY = 'rv-creator-mine-v1';
type Draft = { step: number; type: ContentType | null; fields: Record<string, string | boolean>; cache: Array<[string, { cid: string; size: number }]>;
  published: { manifestCid: string; manifestSha256: string; manifest: CreatorManifest; pinnedBy: string } | null; savedAt: string };
export type MineItem = { asset: string; title: string; type: ContentType; manifestCid: string; txid: string; receivingAddress: string; at: string };

const STEPS = ['안내', '종류', '파일', '이름·가격', '점검', '드는 돈', '올리기', '확인', '완료'];
const FALLBACK_WORD: Record<ContentType, string> = { game: 'GAME', music: 'SONG', book: 'BOOK', ticket: 'TICKET', digital: 'ITEM' };
const FIELD_IDS = ['cw-title', 'cw-desc', 'cw-asset', 'cw-price', 'cw-address', 'cw-entry', 'cw-origin', 'cw-cap-identity', 'cw-cap-payment', 'cw-preview-file',
  'cw-preview-start', 'cw-preview-end', 'cw-book-file', 'cw-book-preview', 'cw-book-pages', 'cw-book-total', 'cw-t-event', 'cw-t-start', 'cw-t-end', 'cw-t-venue',
  'cw-t-qty', 'cw-t-refund', 'cw-t-contact', 'cw-d-label', 'cw-guide-ok'];

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
function list(target: HTMLElement, items: string[], cls = '') {
  target.replaceChildren(...items.map(text => { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; return li; }));
}
const errText = (e: unknown) => e instanceof CreatorError ? (e.detail || e.code) : String((e as Error)?.message ?? e);
const sizeText = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;

async function readFiles(files: Iterable<File>, role: 'content' | 'cover', fromFolder: boolean): Promise<FileInput[]> {
  const out: FileInput[] = [];
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    // 폴더로 고르면 「폴더이름/…」로 온다. 맨 앞 폴더 이름은 묶음 안 경로가 아니다.
    const path = fromFolder && rel.includes('/') ? rel.split('/').slice(1).join('/') : f.name;
    out.push({ path, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, role });
  }
  return out;
}

export type CreatorDeps = {
  invoke: Invoke; askPassword: () => Promise<string | null>; back: () => void;
  /** 시험이 모의 보관소·발행기·저장소를 넣을 수 있다. 화면 기본은 kubo·노드·localStorage. */
  pin?: PinAdapter; issuer?: Issuer; probe?: CidProbe; now?: () => Date; storage?: Storage | null;
  /** 이미 있는 다른 상품(이름 사칭 검사용). 장터 목록을 읽을 수 있을 때만. */
  neighbors?: () => Promise<NameNeighbor[]>;
  /** 판매 현황. 판매 스위치가 꺼져 있거나 읽는 기능이 없으면 null. */
  sales?: (item: MineItem) => Promise<{ count: number; sellerRvn: string } | null>;
  /**
   * 장터 수수료 일정(서명된 목록, market-lists.ts). 없으면(출하 상태 — 받는 길·키 없음) 안내는 「일정을 아직 받지 못했어요」+ 정책 출발값.
   * 요율 숫자는 전부 여기서 읽는다(15% 하드코딩 없음).
   */
  feeSchedule?: () => FeeSchedule | null;
};

export function wireCreatorPublish(deps: CreatorDeps) {
  const pin = deps.pin ?? kuboPinAdapter(deps.invoke);
  const issuer = deps.issuer ?? nodeIssuer(deps.invoke);
  const probe = deps.probe ?? nodeProbe(deps.invoke);
  const sign = nodeSigner(deps.invoke, deps.askPassword);
  const store = (() => { try { return deps.storage === undefined ? window.localStorage : deps.storage; } catch { return null; } })();
  const now = () => deps.now?.() ?? new Date();
  // 수수료 안내의 「지금」 = 체인 높이. 메인넷 노드가 다 따라잡았을 때만 그 높이를 쓰고, 아니면 일정의 시작 시각으로 어림(화면에 「예상」).
  let chainHeight: number | null = null;
  const readChainHeight = async () => {
    try { const s = await deps.invoke<{ chain?: string; blocks?: number; headers?: number }>('node_status');
      chainHeight = s?.chain === 'main' && Number.isSafeInteger(s.blocks) && s.blocks! > 0 && s.blocks === s.headers ? s.blocks! : null; }
    catch { chainHeight = null; }
  };
  const feeOpts = (): FeeNoticeOptions => ({ schedule: deps.feeSchedule?.() ?? null, kind: type, height: chainHeight, now: now().getTime(),
    seller: isRvnAddress(input('cw-address').value.trim()) ? { address: input('cw-address').value.trim(), receivingAddress: input('cw-address').value.trim() } : null });
  let step = 0, type: ContentType | null = null, content: FileInput[] = [], cover: FileInput[] = [];
  let cache: PinCache = new Map(), published: Draft['published'] = null, plan: IssuePlan | null = null, busy = false;
  let chain = 'unknown', taken: boolean | null = null, balanceAtoms: bigint | null = null, neighbors: NameNeighbor[] = [];

  /* ── 저장·이어하기 ── */
  const readJson = <T>(key: string): T | null => { try { const t = store?.getItem(key); return t ? JSON.parse(t) as T : null; } catch { return null; } };
  const writeJson = (key: string, v: unknown) => { try { store?.setItem(key, JSON.stringify(v)); } catch { /* 저장 못 해도 화면은 돈다 */ } };
  function fieldValues(): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (const id of FIELD_IDS) { const e = el<HTMLInputElement>(id); if (e) out[id] = e.type === 'checkbox' ? e.checked : e.value; }
    return out;
  }
  function saveDraft() {
    if ((step === 0 && !type) || step === 8) return;
    writeJson(DRAFT_KEY, { step, type, fields: fieldValues(), cache: [...cache.entries()], published, savedAt: now().toISOString() } satisfies Draft);
  }
  const dropDraft = () => { try { store?.removeItem(DRAFT_KEY); } catch { /* 없음 */ } };
  function restore(d: Draft) {
    type = d.type; cache = new Map(d.cache ?? []);
    for (const [id, v] of Object.entries(d.fields ?? {})) {
      const e = el<HTMLInputElement>(id); if (!e) continue;
      if (e.type === 'checkbox') e.checked = v === true;
      else if (e.tagName === 'SELECT') { const s = e as unknown as HTMLSelectElement; if (v && ![...s.options].some(o => o.value === v)) s.append(new Option(String(v), String(v))); s.value = String(v); }
      else e.value = String(v);
    }
    if (d.published) { try { validateManifest(d.published.manifest); published = d.published; } catch { published = null; } }
    paintKinds();
    // 파일 바이트는 저장하지 않는다 — 올리기 전이면 파일 단계로, 올린 뒤면 마지막 확인으로.
    go(published ? 7 : Math.min(d.step, 2));
  }

  /* ── 단계 표시 ── */
  function paintSteps() {
    const ol = el('cw-steps');
    ol.replaceChildren(...STEPS.map((name, i) => {
      const li = document.createElement('li'); li.textContent = i === 0 ? name : `${'①②③④⑤⑥⑦⑧'[i - 1]} ${name}`;
      if (i === step) li.setAttribute('aria-current', 'step');
      li.className = i < step ? 'done' : i === step ? 'now' : '';
      return li;
    }));
  }
  function setError(text: string) { el('cw-error').textContent = text; }
  function go(n: number) {
    step = Math.max(0, Math.min(8, n));
    document.querySelectorAll<HTMLElement>('#page-creator .cw-panel').forEach(p => { p.hidden = Number(p.dataset.step) !== step; });
    paintSteps(); setError('');
    (el('cw-prev') as HTMLButtonElement).hidden = step === 0 || step === 8;
    (el('cw-next') as HTMLButtonElement).hidden = step === 0 || step >= 7;
    if (step === 2) paintFiles();
    if (step === 3) void enterInfo();
    if (step === 4) runCheck();
    if (step === 5) void paintCost();
    if (step === 6) paintUpload();
    if (step === 7) void prepareConfirm();
    paintNext(); saveDraft();
    el('page-creator').querySelector<HTMLElement>(`.cw-panel[data-step="${step}"] h2`)?.focus?.();
  }

  /* ── 안내 ── */
  list(el('cw-guide-cost'), [BOND_SAY, '네트워크 수수료(아주 적은 RVN)가 따로 들어요.', '이 두 가지는 등록할 때 한 번만 내요.']);
  const paintGuideFee = () => list(el('cw-guide-fee'), feeNotice(null, { ...feeOpts(), kind: null, seller: null }).lines);
  paintGuideFee();
  void readChainHeight().then(paintGuideFee);
  el('cw-switch-note').textContent = `지금은 시험 단계예요. 실제 메인넷 등록은 ${REAL_MAINNET_ISSUE_ENABLED ? '열려' : '꺼져'} 있고, 판매(구매 결제)는 ${OPEN_MARKET_SALES_ENABLED ? '열려' : '꺼져'} 있어요(대표 결정 대기). 시험망에서만 등록할 수 있어요.`;
  el('cw-test-note').textContent = '시험 단계 — 실제 메인넷 등록·판매는 꺼져 있어요.';
  input('cw-guide-ok').onchange = () => { (el('cw-start') as HTMLButtonElement).disabled = !input('cw-guide-ok').checked; };
  el('cw-start').onclick = () => { if (input('cw-guide-ok').checked) go(1); };

  /* ── ① 종류 ── */
  function paintKinds() {
    const box = el('cw-kinds');
    box.replaceChildren(...CONTENT_TYPE_IDS.map(id => {
      const r = CONTENT_TYPES[id];
      const label = document.createElement('label'); label.className = 'cw-kind' + (type === id ? ' on' : '');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'cw-type'; radio.value = id; radio.checked = type === id;
      radio.onchange = () => { if (type !== id) { type = id; content = []; cover = []; published = null; } paintKinds(); paintNext(); saveDraft(); };
      const b = document.createElement('b'); b.textContent = r.label;
      const s = document.createElement('span'); s.textContent = r.say + (r.runsCode ? ' · 검증된 뒤에만 지갑 결제' : '');
      label.append(radio, b, s);
      return label;
    }));
    for (const id of CONTENT_TYPE_IDS) el(`cw-fields-${id}`).hidden = type !== id;
    el('cw-folder-wrap').hidden = type !== 'game';
    if (type) {
      const exts = [...CONTENT_TYPES[type].ext].map(e => '.' + e);
      input('cw-files').accept = exts.join(',');
      el('cw-drop-say').textContent = `${CONTENT_TYPES[type].label}: ${[...CONTENT_TYPES[type].ext].map(e => e.toUpperCase()).join('·')} · 최대 ${CONTENT_TYPES[type].maxFiles}개`;
    }
  }

  /* ── ② 파일 ── */
  function fillSelect(id: string, paths: string[], allowNone = false) {
    const sel = el<HTMLSelectElement>(id), keep = sel.value;
    sel.replaceChildren(...(allowNone ? [new Option('(없음)', '')] : []), ...paths.map(p => new Option(p, p)));
    if (paths.includes(keep) || (allowNone && keep === '')) sel.value = keep;
    else if (paths.includes('index.html')) sel.value = 'index.html';
  }
  function paintFiles() {
    const paths = content.map(f => f.path);
    fillSelect('cw-entry', paths.filter(p => ['html', 'htm'].includes(extOf(p))));
    fillSelect('cw-preview-file', paths);
    fillSelect('cw-book-file', paths.filter(p => ['pdf', 'epub'].includes(extOf(p))));
    fillSelect('cw-book-preview', paths.filter(p => extOf(p) === 'pdf'), true);
    if (el<HTMLSelectElement>('cw-book-preview').value === '' && paths.length > 1) {
      const pv = paths.find(p => extOf(p) === 'pdf' && p !== el<HTMLSelectElement>('cw-book-file').value); if (pv) el<HTMLSelectElement>('cw-book-preview').value = pv;
    }
    list(el('cw-filelist'), [...content, ...cover].map(f => `${f.role === 'cover' ? '표지 · ' : ''}${f.path} · ${sizeText(f.bytes.length)}`));
    el('cw-files-say').textContent = content.length || cover.length ? `${content.length}개 파일${cover.length ? ' · 표지 1장' : ''}` : '아직 고른 파일이 없어요.';
  }
  async function addFiles(files: FileInput[], role: 'content' | 'cover') {
    if (role === 'cover') cover = files.slice(0, 1);
    else { const seen = new Set(files.map(f => f.path.toLowerCase())); content = [...content.filter(f => !seen.has(f.path.toLowerCase())), ...files]; }
    published = null; plan = null; paintFiles(); paintNext(); saveDraft();
  }
  input('cw-files').onchange = async () => addFiles(await readFiles(Array.from(input('cw-files').files ?? []), 'content', false), 'content');
  input('cw-folder').onchange = async () => { content = []; await addFiles(await readFiles(Array.from(input('cw-folder').files ?? []), 'content', true), 'content'); };
  input('cw-cover').onchange = async () => addFiles(await readFiles(Array.from(input('cw-cover').files ?? []), 'cover', false), 'cover');
  const drop = el('cw-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('over');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const covers = files.filter(f => /^cover\.(png|jpe?g|webp)$/i.test(f.name) && type !== 'digital' && type !== 'ticket');
    await addFiles(await readFiles(files.filter(f => !covers.includes(f)), 'content', false), 'content');
    if (covers.length) await addFiles(await readFiles(covers, 'cover', false), 'cover');
  });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input('cw-files').click(); } });
  drop.addEventListener('click', () => input('cw-files').click());

  /* ── ③ 이름·설명·가격 ── */
  /** 종류로 정해지는 앞부분(RV.M. 등). 종류를 아직 안 골랐으면 디지털로 보인다(① 단계에서 막히므로 실제로는 쓰이지 않는다). */
  const namePrefix = () => assetPrefixFor(type ?? 'digital');
  const assetName = () => namePrefix() + input('cw-asset').value.trim().toUpperCase();
  const nameCheck = () => checkCreatorAssetName(assetName(), undefined, { type: type ?? 'digital' });
  function paintPrefix() {
    el('cw-prefix').textContent = namePrefix();
    el('cw-kind-letter').textContent = `「${namePrefix()}」의 ${ASSET_KIND_LETTER[type ?? 'digital']} 는 ${CONTENT_TYPES[type ?? 'digital'].label} 칸이라는 뜻이에요. 앞부분은 고른 종류로 정해져요.`;
  }
  /* 체인 중복 조회 줄(③·⑦ 단계): 비어 있음 / 이미 있음 / 확인 불가. 확인 불가면 ⑦에서 등록을 막는다(planIssue 정책). */
  function paintDup(target: HTMLElement, state: boolean | null | 'checking' | 'invalid') {
    const [text, cls] = state === 'checking' ? ['조회하는 중…', 'meta']
      : state === 'invalid' ? ['이름을 규칙에 맞게 고치면 조회해요.', 'meta']
      : state === true ? ['이미 있어요 — 체인에 같은 이름이 있어 등록할 수 없어요. 다른 이름을 골라 주세요.', 'creator-bad']
      : state === false ? ['비어 있어요 — 노드에 물어 확인했어요.', 'creator-good']
      : ['확인 불가 — 노드에 묻지 못했어요(노드가 꺼져 있거나 동기화 중). 확인될 때까지 등록할 수 없어요 → 「다시 조회」', 'creator-bad'];
    target.textContent = text; target.className = cls;
  }
  function paintFee() {
    const raw = input('cw-price').value.trim();
    const atoms = raw ? rvnToAtoms(raw) : null;
    const n = feeNotice(atoms, feeOpts());
    const box = el('cw-fee');
    const lines = raw && !atoms ? ['가격은 RVN 숫자로, 소수점 아래 8자리까지 적어 주세요.', ...n.lines] : raw && atoms && !n.mine ? ['가격이 너무 작아 수수료를 떼고 나면 받을 돈이 남지 않아요.', ...n.lines] : n.lines;
    const ul = document.createElement('ul'); list(ul, raw ? lines : ['가격을 비우면 무료로 올려요(판매 없음).', ...lines]);
    box.replaceChildren(ul);
  }
  function suggestions() {
    const box = el('cw-suggest');
    const t = new Set([...neighbors.map(n => n.asset)]);
    const names = suggestNames(input('cw-title').value, t, { type: type ?? 'digital', fallback: FALLBACK_WORD[type ?? 'digital'], n: 3 });
    box.replaceChildren(...(names.length ? [Object.assign(document.createElement('span'), { className: 'meta', textContent: '이름 제안: ' })] : []), ...names.map(name => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost cw-chip'; b.textContent = name;
      b.onclick = () => { input('cw-asset').value = name.slice(namePrefix().length); input('cw-asset').dataset.touched = '1'; void nameLine(); saveDraft(); };
      return b;
    }));
  }
  let nameSeq = 0;
  async function nameLine() {
    const c = nameCheck();
    el('cw-name-say').textContent = c.valid ? `상품 등록증 이름: ${c.name} (${c.name.length}/30자)` : c.problems.join(' ');
    const conflict = nameConflicts(assetName(), input('cw-title').value, neighbors);
    const seq = ++nameSeq;
    taken = conflict.taken ? true : null;
    paintDup(el('cw-dup'), !c.valid ? 'invalid' : conflict.taken ? true : 'checking');
    if (c.valid && !conflict.taken) {
      taken = await askNameTaken(deps.invoke, assetName());
      if (seq !== nameSeq) return;
      paintDup(el('cw-dup'), taken);
    }
    const warn = [...conflict.say];
    if (taken && !conflict.taken) warn.unshift('이 이름은 이미 체인에 있어요. 다른 이름을 골라 주세요.');
    if (taken === null && c.valid) warn.push('이 이름이 체인에 이미 있는지 확인 불가 — 마지막 확인 단계에서 다시 조회해요. 그때도 확인 불가면 등록할 수 없어요.');
    list(el('cw-name-warn'), warn, 'creator-warn');
    paintNext();
  }
  async function enterInfo() {
    paintPrefix();
    try { neighbors = (await deps.neighbors?.()) ?? []; } catch { neighbors = []; }
    if (!input('cw-asset').value && !input('cw-asset').dataset.touched) {
      const s = suggestNames(input('cw-title').value, new Set(neighbors.map(n => n.asset)), { type: type ?? 'digital', fallback: FALLBACK_WORD[type ?? 'digital'], n: 1 })[0];
      if (s) input('cw-asset').value = s.slice(namePrefix().length);
    }
    if (type === 'ticket' && !input('cw-t-contact').value) input('cw-t-contact').placeholder = 'hello@example.com';
    suggestions(); paintFee(); await nameLine();
  }
  input('cw-title').addEventListener('input', () => {
    if (!input('cw-asset').dataset.touched) {
      const s = suggestNames(input('cw-title').value, new Set(neighbors.map(n => n.asset)), { type: type ?? 'digital', fallback: FALLBACK_WORD[type ?? 'digital'], n: 1 })[0];
      if (s) input('cw-asset').value = s.slice(namePrefix().length);
    }
    suggestions(); void nameLine();
  });
  input('cw-asset').addEventListener('input', () => { input('cw-asset').dataset.touched = '1'; void nameLine(); });
  el('cw-dup-recheck').onclick = () => void nameLine();
  input('cw-price').addEventListener('input', paintFee);
  el('cw-new-address').onclick = async () => {
    try { const a = await deps.invoke<unknown>('new_address', { label: 'creator' }); input('cw-address').value = typeof a === 'string' ? a : String((a as { address?: string })?.address ?? ''); paintNext(); saveDraft(); }
    catch (e) { setError(`주소를 받지 못했어요(${errText(e)}) → 지갑이 열려 있는지 확인하고 다시 눌러 주세요.`); }
  };
  for (const id of FIELD_IDS) el(id)?.addEventListener('input', () => { published = published && step < 6 ? null : published; paintNext(); saveDraft(); });
  for (const id of FIELD_IDS) el(id)?.addEventListener('change', () => { paintNext(); saveDraft(); });

  const num = (id: string) => Number(input(id).value.trim());
  const isoOf = (id: string) => { const v = input(id).value; const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
  function details(): Details {
    const sel = (id: string) => el<HTMLSelectElement>(id).value;
    const address = input('cw-address').value.trim();
    switch (type) {
      case 'game': return { entry: sel('cw-entry'), origin: input('cw-origin').value.trim() || null, capabilities: { identity: input('cw-cap-identity').checked, payment: input('cw-cap-payment').checked } };
      case 'music': return { previewFile: sel('cw-preview-file'), previewStartMs: Math.round(num('cw-preview-start') * 1000), previewEndMs: Math.round(num('cw-preview-end') * 1000) };
      case 'book': {
        const pv = sel('cw-book-preview') || null, book = sel('cw-book-file');
        return { bookFile: book, format: extOf(book) === 'epub' ? 'epub' : 'pdf', previewFile: pv, previewPages: pv ? Math.round(num('cw-book-pages')) : 0,
          pageCount: input('cw-book-total').value.trim() ? Math.round(num('cw-book-total')) : null };
      }
      case 'ticket': return { eventName: input('cw-t-event').value.trim(), startsAt: isoOf('cw-t-start'), endsAt: isoOf('cw-t-end') || null, venue: input('cw-t-venue').value.trim(),
        quantity: Math.round(num('cw-t-qty')), redemption: { method: 'creator-signed-code', checkerAddress: address }, refundPolicy: el<HTMLTextAreaElement>('cw-t-refund').value.trim(),
        contact: input('cw-t-contact').value.trim() };
      default: return { label: input('cw-d-label').value.trim() };
    }
  }
  function gather(): PublishInput {
    const price = input('cw-price').value.trim(), address = input('cw-address').value.trim();
    return { type: type ?? 'digital', asset: assetName(), title: input('cw-title').value, description: el<HTMLTextAreaElement>('cw-desc').value, files: [...content, ...cover],
      creatorAddress: address, receivingAddress: address, priceAtoms: price ? (rvnToAtoms(price) ?? 'invalid') : null, details: details(), now: now() };
  }
  /** 이 단계에서 다음으로 못 가는 이유 — 「원인 → 다음 행동」 한 줄씩. */
  function infoProblems(): string[] {
    const p: string[] = [], inp = gather();
    if (!inp.title.trim()) p.push('제목이 비어 있어요 → 구매자에게 보일 제목을 적어 주세요.');
    const n = checkCreatorAssetName(inp.asset, undefined, { type: inp.type });
    if (!n.valid) p.push(`상품 등록증 이름이 규칙에 안 맞아요(${n.problems[0]}) → 제안된 이름을 누르거나 영문 대문자로 고쳐 주세요.`);
    if (taken === true) p.push('이미 있는 이름이에요 → 다른 이름을 골라 주세요.');
    if (!isRvnAddress(inp.creatorAddress)) p.push('받을 주소가 없거나 틀려요 → 「새 주소 받기」를 눌러 주세요.');
    if (inp.priceAtoms === 'invalid') p.push('가격이 숫자가 아니에요 → 예: 20 또는 12.5');
    if (inp.priceAtoms && inp.priceAtoms !== 'invalid' && !splitsAtCeiling(inp.priceAtoms)) p.push('가격이 너무 작아요 → 수수료를 떼고도 남도록 올려 주세요.');
    const d = inp.details as unknown as Record<string, unknown>;
    if (type === 'music' && !((d.previewEndMs as number) > (d.previewStartMs as number) + 999 && (d.previewEndMs as number) - (d.previewStartMs as number) <= 60_000))
      p.push('미리듣기 구간이 이상해요 → 1초 이상 60초 이하로 정해 주세요.');
    if (type === 'book' && !d.bookFile) p.push('책 파일(PDF·EPUB)이 없어요 → ② 단계에서 책 파일을 넣어 주세요.');
    if (type === 'book' && d.previewFile && !((d.previewPages as number) >= 1 && (d.previewPages as number) <= 50)) p.push('미리보기 쪽수가 이상해요 → 1~50 사이로 적어 주세요.');
    if (type === 'ticket') {
      if (!d.eventName || !d.venue) p.push('행사 이름·장소가 비어 있어요 → 적어 주세요.');
      if (!d.startsAt) p.push('행사 시작 날짜·시각이 없어요 → 골라 주세요.');
      else if (Date.parse(d.startsAt as string) <= now().getTime()) p.push('행사 시작이 이미 지났어요 → 앞으로의 날짜를 골라 주세요.');
      if (d.endsAt && d.startsAt && Date.parse(d.endsAt as string) <= Date.parse(d.startsAt as string)) p.push('끝나는 시각이 시작보다 빨라요 → 다시 골라 주세요.');
      if (!((d.quantity as number) >= 1 && (d.quantity as number) <= 100000)) p.push('판매 수량이 이상해요 → 1 이상 적어 주세요.');
      if (!d.refundPolicy || !d.contact) p.push('환불 규정·연락처가 비어 있어요 → 구매자가 볼 수 있게 적어 주세요.');
    }
    if (type === 'digital' && !d.label) p.push('상품 종류 한 줄이 비어 있어요 → 예: 그림 모음');
    if (type === 'game' && !d.entry) p.push('여는 HTML 파일이 없어요 → ② 단계에서 index.html 을 넣어 주세요.');
    return p;
  }

  /* ── ④ 자동 점검 ── */
  function checkResult(): { problems: string[]; warnings: string[]; files: number; bytes: number } {
    const inp = gather();
    // 이름·주소·제목 문제는 infoProblems 가 쉬운 말로 이미 말한다. 여기서는 파일 문제만 더한다.
    const { check } = precheck(inp);
    const files = check.problems.map(x => `${x.path ? x.path + ': ' : ''}${x.say} → 파일을 바꾸거나 빼고 다시 점검해 주세요.`);
    return { problems: [...infoProblems(), ...files],
      warnings: check.warnings.map(w => (w.path ? `${w.path}: ` : '') + w.say), files: check.files.length, bytes: check.totalBytes };
  }
  function runCheck(): boolean {
    const r = checkResult();
    const box = el('cw-check');
    const head = document.createElement('p');
    head.textContent = r.problems.length ? `고칠 곳 ${r.problems.length}개` : `올릴 수 있어요 · 파일 ${r.files}개 · ${sizeText(r.bytes)}${r.warnings.length ? ` · 주의 ${r.warnings.length}개` : ''}`;
    head.className = r.problems.length ? 'creator-bad' : 'creator-good';
    const bad = document.createElement('ul'); list(bad, r.problems);
    const warn = document.createElement('ul'); list(warn, r.warnings.map(w => '주의 · ' + w), 'creator-warn');
    const note = document.createElement('p'); note.className = 'meta'; note.textContent = CONTENT_TYPES[type ?? 'digital'].runsCode ? SCRIPT_NOTICE : '자동 점검은 파일 모양만 봐요. 내용이 정직한지는 판매자 책임이에요.';
    box.replaceChildren(head, ...(r.problems.length ? [bad] : []), ...(r.warnings.length ? [warn] : []), note);
    return r.problems.length === 0;
  }
  el('cw-recheck').onclick = () => { runCheck(); paintNext(); };

  /* ── ⑤ 드는 돈 ── */
  async function readBalance() {
    try {
      const b = await deps.invoke<{ confirmed?: number }>('wallet_balance');
      const a = rvnToAtoms(Number(b?.confirmed ?? NaN).toFixed(8));
      balanceAtoms = a === null ? null : BigInt(a);
    } catch { balanceAtoms = null; }
  }
  async function paintCost() {
    await readBalance();
    const c = costPlan({ burnRvn: nameCheck().burnRvn, networkFeeAtoms: null, balanceAtoms });
    list(el('cw-cost'), [...c.lines, ...(c.balanceAtoms !== null ? [`지금 잔액(확정) ${atomsToRvn(c.balanceAtoms)} RVN`] : [])]);
    el('cw-cost').querySelectorAll('li')[c.lines.length - 1]?.classList.add(c.enough === false ? 'creator-bad' : c.enough ? 'creator-good' : 'creator-warn');
    const ul = document.createElement('ul'); const raw = input('cw-price').value.trim();
    list(ul, ['판매 수수료(지금 내는 돈 아님):', ...feeNotice(raw ? rvnToAtoms(raw) : null, feeOpts()).lines]);
    el('cw-cost-fee').replaceChildren(ul);
    if (c.enough === false) {
      try { const r = await deps.invoke<{ address?: string } | string>('receive_address', { fresh: false }); const a = typeof r === 'string' ? r : r?.address;
        el('cw-receive').textContent = a ? `RVN 받는 내 주소: ${a} (지갑 「받기」 화면과 같아요)` : '지갑 「받기」 화면에서 내 주소를 확인해 주세요.'; }
      catch { el('cw-receive').textContent = '지갑 「받기」 화면에서 내 주소를 확인해 주세요.'; }
    } else el('cw-receive').textContent = '';
  }
  el('cw-balance').onclick = () => void paintCost();

  /* ── ⑥ 올리기 ── */
  el('cw-pin-holder').textContent = pin.holder;
  function progress(done: number, total: number) {
    const pct = total ? Math.round(done / total * 100) : 0;
    el('cw-progress').setAttribute('aria-valuenow', String(pct)); el('cw-progress-bar').style.width = pct + '%';
  }
  function paintUpload() {
    (el('cw-upload') as HTMLButtonElement).disabled = !!published || busy;
    (el('cw-pin-check') as HTMLButtonElement).disabled = !published || busy;
    if (published) { progress(1, 1); el('cw-upload-say').textContent = '다 올렸어요. 아직 아무에게도 보이지 않아요 — 마지막 확인에서 등록해야 목록에 나타나요.'; }
    else if (!content.length && CONTENT_TYPES[type ?? 'digital'].minFiles > 0) el('cw-upload-say').textContent = '이어서 하는 중이면 ② 단계에서 같은 파일을 다시 골라 주세요. 이미 올린 파일은 건너뛰어요.';
    else { progress(0, 1); el('cw-upload-say').textContent = cache.size ? `이미 올린 파일 ${cache.size}개는 건너뛰어요.` : ''; }
  }
  async function upload() {
    if (busy || published) return;
    if (!runCheck()) { setError('점검에서 고칠 곳이 있어요 → ④ 단계로 돌아가 고쳐 주세요.'); return; }
    busy = true; paintUpload();
    el('cw-upload-say').textContent = pin.real ? '올리는 중… 파일이 많으면 오래 걸려요. 닫아도 다음에 이어서 할 수 있어요.' : '시험 보관소에 올리는 중…';
    try {
      const r: PublishResult = await publishContent(gather(), pin, sign, { cache, onProgress: p => {
        progress(p.done, p.total); el('cw-upload-say').textContent = `${p.done}/${p.total} · ${p.path}${p.skipped ? ' (이미 올림 — 건너뜀)' : ''}`; saveDraft(); } });
      published = { manifestCid: r.manifestCid, manifestSha256: r.manifestSha256, manifest: r.manifest, pinnedBy: r.pinnedBy };
      saveDraft();
    } catch (e) {
      setError(`올리지 못했어요(${errText(e)}) → IPFS 가 켜져 있는지 확인하고 「올리고 서명하기」를 다시 눌러 주세요. 올린 파일은 건너뛰어요.`);
    } finally { busy = false; paintUpload(); paintNext(); }
  }
  el('cw-upload').onclick = () => void upload();
  el('cw-pin-check').onclick = async () => {
    if (!published) return;
    el('cw-pin-say').textContent = '찾아보는 중…';
    const h = await checkPinHealth(published.manifestCid, published.manifest, probe);
    el('cw-pin-say').textContent = h.say; el('cw-pin-say').className = h.ok ? 'creator-good' : 'creator-bad';
  };

  /* ── ⑦ 마지막 확인 ── */
  async function prepareConfirm() {
    if (!published) { setError('아직 올리지 않았어요 → ⑥ 단계에서 올려 주세요.'); return; }
    const asset = published.manifest.asset;
    paintDup(el('cw-c-dup'), 'checking');
    const [node, isTaken] = await Promise.allSettled([deps.invoke<{ chain?: string }>('node_status'), deps.invoke<boolean>('name_taken', { name: asset })]);
    chain = node.status === 'fulfilled' ? String(node.value?.chain ?? 'unknown') : 'unknown';
    taken = nameTakenSettled(isTaken);
    paintDup(el('cw-c-dup'), taken);
    await readBalance();
    el('cw-c-name').textContent = asset;
    el('cw-c-chain').textContent = chain === 'main' ? '메인넷(실제 돈)' : ['test', 'regtest'].includes(chain) ? `시험망(${chain})` : `알 수 없음(${chain})`;
    const n = feeNotice(published.manifest.price?.atoms ?? null, feeOpts());
    el('cw-c-fee').textContent = !published.manifest.price ? '무료 상품은 수수료가 없어요(목록에 「무료」로 보여요).'
      : !n.scheduled ? `수수료 일정을 아직 받지 못했어요 — 일정을 받으면 판매가 열려요. ${n.lines[2] ?? ''}`
      : `지금 ${n.percent}%${n.next ? ` → ${n.next.date} 무렵부터 ${n.next.percent}%` : ''} — 팔릴 때마다 자동으로 나뉘어요. ${n.mine ? `내 가격이면 지금 나 ${n.mine.sellerRvn} RVN · 수수료 ${n.mine.feeRvn} RVN${n.mine.later && n.next ? `, ${n.next.date}부터 나 ${n.mine.later.sellerRvn} RVN · 수수료 ${n.mine.later.feeRvn} RVN` : ''}.` : ''}`;
    paintPlan();
  }
  function paintPlan() {
    if (!published) return;
    plan = planIssue({ asset: published.manifest.asset, manifestCid: published.manifestCid, chain, ownedAssets: [], nameTaken: taken,
      chainBurnRvn: null, typedName: input('cw-typed').value.trim(), realMainnetEnabled: REAL_MAINNET_ISSUE_ENABLED, type: published.manifest.type });
    const c = costPlan({ burnRvn: plan.burn.rvn, networkFeeAtoms: null, balanceAtoms });
    el('cw-c-burn').textContent = `${plan.burn.rvn} RVN — 수수료가 아니라 보증이에요(소각, 아무도 받지 않음)`;
    el('cw-c-burn-check').textContent = plan.burn.status === 'unverifiable' ? '체인과 대조: 확인 불가 — 저장소에 적힌 값이에요. 노드에 묻는 방법이 없어 실제 소각액과 대조하지 못했어요.' : plan.burn.say;
    list(el('cw-c-irreversible'), plan.irreversible);
    const blockers = plan.blockers.filter(b => !b.includes('다시 적어'));
    if (c.enough === false) blockers.push(`잔액이 ${atomsToRvn(c.shortAtoms)} RVN 모자라요 → ⑤ 단계의 받는 주소로 RVN 을 받은 뒤 다시 와 주세요.`);
    list(el('cw-c-blockers'), blockers, 'creator-bad');
    (el('cw-issue') as HTMLButtonElement).disabled = !plan.canIssue || c.enough === false || busy;
  }
  input('cw-typed').addEventListener('input', paintPlan);
  el('cw-c-dup-recheck').onclick = async () => {
    if (!published || busy) return;
    paintDup(el('cw-c-dup'), 'checking');
    taken = await askNameTaken(deps.invoke, published.manifest.asset);
    paintDup(el('cw-c-dup'), taken); paintPlan();
  };
  async function issue() {
    if (!published || !plan?.canIssue || busy) return;
    busy = true; (el('cw-issue') as HTMLButtonElement).disabled = true;
    el('cw-issue-say').textContent = '등록하는 중…';
    try {
      const { txid } = await issuer.issue(plan.params);
      const m = published.manifest;
      const req = buildListingRequest({ manifest: m, manifestCid: published.manifestCid, manifestSha256: published.manifestSha256, issueTxid: txid, now: now() });
      const item: MineItem = { asset: m.asset, title: m.title, type: m.type, manifestCid: published.manifestCid, txid, receivingAddress: m.creator.receivingAddress, at: now().toISOString() };
      writeJson(MINE_KEY, [item, ...(readJson<MineItem[]>(MINE_KEY) ?? []).filter(x => x.asset !== item.asset)].slice(0, 200));
      el('cw-txid').textContent = txid;
      el<HTMLTextAreaElement>('cw-request').value = JSON.stringify(req, null, 2);
      el<HTMLTextAreaElement>('cw-share').value = [`「${m.title}」을(를) 레이븐볼트 열린 장터에 올렸어요.`, `상품 등록증 이름: ${m.asset}`,
        '레이븐볼트 → 게임 → 열린 장터에서 이 이름으로 찾을 수 있어요(장터는 아직 시험 중).', `매니페스트: ipfs://${published.manifestCid}`].join('\n');
      el('cw-issue-say').textContent = '';
      dropDraft(); published = null; content = []; cover = []; cache = new Map();
      go(8); await paintMine();
    } catch (e) {
      el('cw-issue-say').textContent = `등록하지 못했어요(${errText(e)}) → 잔액과 네트워크를 확인하고 다시 눌러 주세요. 올린 파일은 그대로예요.`;
    } finally { busy = false; if (step === 7) paintPlan(); }
  }
  el('cw-issue').onclick = () => void issue();

  /* ── ⑧ 완료 ── */
  async function paintMine() {
    const mine = readJson<MineItem[]>(MINE_KEY) ?? [];
    list(el('cw-mine'), mine.map(m => `${m.title} · ${m.asset} · ${CONTENT_TYPES[m.type]?.label ?? m.type}`));
    const lines: string[] = [];
    for (const m of mine.slice(0, 5)) {
      let s: { count: number; sellerRvn: string } | null = null;
      try { s = (await deps.sales?.(m)) ?? null; } catch { s = null; }
      lines.push(s ? `${m.asset}: ${s.count}건 · 내 몫 ${s.sellerRvn} RVN` : `${m.asset}: ${OPEN_MARKET_SALES_ENABLED ? '판매 현황을 읽지 못했어요.' : '판매 기능이 아직 꺼져 있어 판매가 없어요.'}`);
    }
    el('cw-sales').textContent = lines.join(' / ') || '아직 등록한 상품이 없어요.';
  }
  el('cw-share-copy').onclick = () => { void navigator.clipboard?.writeText(el<HTMLTextAreaElement>('cw-share').value).catch(() => undefined); };

  /* ── 이전·다음 ── */
  function canNext(): string | null {
    if (step === 1 && !type) return '파는 것을 골라 주세요.';
    if (step === 2 && type && content.length < CONTENT_TYPES[type].minFiles) return '파일을 끌어다 놓거나 골라 주세요.';
    if (step === 3) { const p = infoProblems(); return p[0] ?? null; }
    if (step === 4) { const r = checkResult(); return r.problems[0] ?? null; }
    if (step === 6 && !published) return '먼저 올려 주세요.';
    return null;
  }
  function paintNext() { const why = canNext(); (el('cw-next') as HTMLButtonElement).disabled = why !== null; (el('cw-next') as HTMLButtonElement).title = why ?? ''; }
  el('cw-next').onclick = () => { const why = canNext(); if (why) { setError(why); return; } go(step + 1); };
  el('cw-prev').onclick = () => go(step - 1);
  el('creator-back').onclick = () => { saveDraft(); deps.back(); };

  /* ── 시작 ── */
  paintKinds(); paintFee(); go(0);
  const draft = readJson<Draft>(DRAFT_KEY);
  if (draft && (draft.type || draft.published)) {
    el('cw-resume').hidden = false;
    el('cw-resume-say').textContent = `지난번 올리던 것이 있어요${draft.published ? '(파일은 다 올렸어요)' : ''}.`;
    el('cw-resume-go').onclick = () => { el('cw-resume').hidden = true; restore(draft); };
    el('cw-resume-drop').onclick = () => { el('cw-resume').hidden = true; dropDraft(); };
  }
  return { go, paintMine, get step() { return step; } };
}
