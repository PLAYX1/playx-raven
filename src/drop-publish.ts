import { assetPrefixFor, type NameNeighbor } from '../core/creator/asset-name';
import { atomsToRvn, base64Decode, rvnToAtoms, sha256Hex } from '../core/creator/bytes';
import { COVER_EXT, extOf, sniff, type ContentType, type FileInput } from '../core/creator/limits';
import { buildListingRequest } from '../core/creator/listing';
import { CreatorError, isRvnAddress, type CreatorManifest, type Details, type MusicSection } from '../core/creator/manifest';
import { feeNotice } from '../core/creator/open-market';
import { bpsPercent, policySchedule, ruleFor, type FeeSchedule } from '../core/creator/fee-schedule';
import {
  NETWORK_FEE_FALLBACK_ATOMS, REAL_MAINNET_ISSUE_ENABLED, costPlan, planIssue, publishContent,
  type CidProbe, type Issuer, type MessageSigner, type PinAdapter, type PinCache, type PublishInput,
} from '../core/creator/publish';
import { LOCK_COPY, lockableType, lockedInputFor, markBackedUp, readBackups, saveKeyFile, type ClipMaker } from './lock-ui';
import { kuboPinAdapter, nodeIssuer, nodeProbe, nodeSigner, MINE_KEY, type MineItem } from './creator-publish';
import { copy, stretchText, type CopyKey, type DropLang } from './drop-copy';
import { defaultPreview, defaultPrice, guessDrop, kindWord, parsePastedCid, suggestAsset, type DroppedFile, type Guess, type MusicFormat } from './drop-detect';
import { DROP_MANIFEST_V3_ENABLED, musicExtFrom, publishV3, readManifestAny } from './drop-manifest';
import { THEMES, THEME_IDS, THEME_LABEL, TEMPLATES, defaultTemplate, renderStorefront, templatesFor, type Look, type StoreModel, type TemplateId, type ThemeId } from './drop-look';
import { genreLabel, genresFor, parseGenreTags, suggestGenre, type GenreValue } from './drop-genre';
import { acceptsDrop, dropGates, nextState, type Chip, type DropEvent, type DropState } from './drop-state';

/*
 * 「끌어놓기 발행」 — 한 화면 + 단추 하나. 기존 9단계 마법사(creator-publish.ts)는 「자세히(단계별로)」로 남긴다.
 *
 * 파일이 들어오는 길(셋 다 같은 결과):
 *   ① 끌어놓기 — 데스크탑(Tauri)은 창이 드롭을 가로채 **경로**만 준다(main.ts 의 drop-files 이벤트 → dropPaths).
 *      경로 내용은 러스트 creator_dropped_list/read 가 「방금 떨어뜨린 것」만 읽어 준다(dropbox.rs 규칙).
 *      브라우저(또는 dragDropEnabled 를 끈 창)는 HTML5 drop 의 DataTransfer(폴더는 webkitGetAsEntry) → dropFiles.
 *   ② 클릭해서 고르기 — <input type=file multiple> · 폴더는 webkitdirectory.
 *   ③ IPFS 주소 붙여넣기 — 받아지는지(cid_alive) 보고, 내용(creator_cid_read)이 상품 정보(매니페스트)면 그대로 발행 준비,
 *      파일이면 그 파일을 넣고 CID 를 이어하기 캐시에 넣어 다시 올리지 않는다. 못 받으면 거절.
 *
 * 안전 장치는 마법사와 같다(drop-state.ts dropGates + 발행 직전 core planIssue). 시드·비밀번호를 저장·기록하지 않는다.
 * 초안(localStorage)에는 공개 정보만: 칸 값·꾸밈·곡 순서·파일 지문(SHA-256)·CID 캐시 — 파일 바이트 없음.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export const DROP_DRAFT_KEY = 'rv-drop-draft-v1';

export type DropDeps = {
  invoke: Invoke; askPassword: () => Promise<string | null>; back: () => void;
  /** #page-creator. 화면은 이 안 맨 위에 붙고, 마법사는 「자세히」에서만 보인다. */
  root: HTMLElement;
  /** 「자세히」: 지금 고른 것을 마법사에 넘겨 연다. */
  openWizard?: (p: WizardPrefill | null) => void;
  pin?: PinAdapter; issuer?: Issuer; probe?: CidProbe; now?: () => Date; storage?: Storage | null;
  neighbors?: () => Promise<NameNeighbor[]>;
  /** 서명된 수수료 일정(마법사와 같은 것 — main.ts 의 marketLists). 없으면 정책 출발값으로 안내만 하고 판매는 닫혀 있다. */
  feeSchedule?: () => FeeSchedule | null;
  lang?: DropLang; stretch?: number;
  /** 열람 보호(RV-LOCK v1): 열쇠 파일을 저장할 폴더 고르기 · 미리듣기 클립 만들기(시험이 바꾼다). */
  pickFolder?: () => Promise<string | null>; makeClip?: ClipMaker;
};
export type WizardPrefill = { type: ContentType; content: FileInput[]; cover: FileInput[]; fields: Record<string, string | boolean> };

type Draft = {
  v: 1; type: ContentType; format: MusicFormat | null; fields: Fields; look: Look; genre?: GenreValue; tracks: Array<{ path: string; title: string; durationMs: number | null }>;
  fileShas: string[]; cache: Array<[string, { cid: string; size: number }]>; savedAt: string;
  published: { manifestCid: string; manifestSha256: string; manifest: CreatorManifest; pinnedBy: string } | null;
};
type Fields = {
  title: string; description: string; work: string; price: string; address: string; previewStart: string; previewEnd: string;
  bookPreviewPages: string; bookPages: string; tEvent: string; tStart: string; tEnd: string; tVenue: string; tQty: string; tRefund: string; tContact: string; dLabel: string;
};
const EMPTY_FIELDS: Fields = { title: '', description: '', work: '', price: '', address: '', previewStart: '0', previewEnd: '30', bookPreviewPages: '10', bookPages: '',
  tEvent: '', tStart: '', tEnd: '', tVenue: '', tQty: '100', tRefund: '', tContact: '', dLabel: '' };

const b64bytes = (s: string) => base64Decode(String(s ?? ''));
const errText = (e: unknown) => e instanceof CreatorError ? (e.detail || e.code) : String((e as Error)?.message ?? e);

/** DataTransfer → 파일 목록(폴더는 끝까지 들어간다). 경로는 「폴더/…」 의 맨 앞 폴더를 뗀다(묶음 안 경로). */
export async function readDataTransfer(dt: DataTransfer): Promise<{ files: DroppedFile[]; folderName: string }> {
  const out: DroppedFile[] = []; let folderName = '';
  const items = Array.from(dt.items ?? []).filter(i => i.kind === 'file');
  const entries = items.map(i => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  if (entries.length && entries.every(Boolean)) {
    const dirs = entries.filter(e => e!.isDirectory);
    if (dirs.length === 1 && entries.length === 1) folderName = dirs[0]!.name;
    const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
      if (out.length > 2000) return;
      if (e.isFile) {
        const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
        out.push({ path: prefix + e.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type });
      } else if (e.isDirectory) {
        const reader = (e as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const c of batch) await walk(c, prefix + e.name + '/');
        }
      }
    };
    for (const e of entries) await walk(e!, '');
    if (folderName) for (const f of out) f.path = f.path.split('/').slice(1).join('/');
    return { files: out, folderName };
  }
  for (const f of Array.from(dt.files ?? [])) out.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type });
  return { files: out, folderName };
}

async function readInputFiles(list: FileList | null, folder: boolean): Promise<{ files: DroppedFile[]; folderName: string }> {
  const files: DroppedFile[] = []; let folderName = '';
  for (const f of Array.from(list ?? [])) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    if (folder && rel.includes('/')) folderName ||= rel.split('/')[0];
    files.push({ path: folder && rel.includes('/') ? rel.split('/').slice(1).join('/') : f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type });
  }
  return { files, folderName };
}

export function wireDropPublish(deps: DropDeps) {
  const doc = deps.root.ownerDocument;
  const lang: DropLang = deps.lang ?? 'ko';
  const say = (k: CopyKey, v: Record<string, string | number> = {}) => stretchText(copy(lang, k, v), deps.stretch ?? 1);
  const sayRaw = (s: string) => stretchText(s, deps.stretch ?? 1);
  const pin = deps.pin ?? kuboPinAdapter(deps.invoke);
  const issuer = deps.issuer ?? nodeIssuer(deps.invoke);
  const probe = deps.probe ?? nodeProbe(deps.invoke);
  const sign: MessageSigner = nodeSigner(deps.invoke, deps.askPassword);
  const store = (() => { try { return deps.storage === undefined ? window.localStorage : deps.storage; } catch { return null; } })();
  const now = () => deps.now?.() ?? new Date();
  /** 암호화 상품이면 열쇠 파일을 저장해야 발행을 마칠 수 있다(열쇠를 잃으면 판매자도 못 연다). */
  const needsBackup = () => !!published?.manifest.lock && !readBackups(store)[published.manifest.asset];

  /* ── 상태 ── */
  let state: DropState = 'idle';
  let guess: Guess | null = null, type: ContentType = 'digital', format: MusicFormat | null = null;
  let content: FileInput[] = [], cover: FileInput | null = null;
  let tracks: Array<{ path: string; title: string; durationMs: number | null }> = [];
  let fields: Fields = { ...EMPTY_FIELDS };
  let look: Look = { template: 'basic', theme: 'auto', tagline: '', coverImage: null, background: null, gallery: [] };
  let genre: GenreValue = { main: null, tags: [] };
  let cache: PinCache = new Map(), published: Draft['published'] = null;
  let pastedCids: Array<{ cid: string; alive: boolean | null }> = [];
  let taken: boolean | null | 'checking' = 'checking', chain = 'unknown', balanceAtoms: bigint | null = null, neighbors: NameNeighbor[] = [];
  let chainHeight: number | null = null;
  let urls: string[] = [], coverUrl: string | null = null, audioUrls = new Map<string, string>();
  let touched = { work: false, price: false, preview: false };
  let entering = false;
  let busy = false, progress = { done: 0, total: 0, path: '' }, doneInfo: { asset: string; txid: string; share: string } | null = null;

  /* ── 뼈대(고정 부품, 글은 전부 textContent) ── */
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
    const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e;
  };
  const shell = h('section', { class: 'dp', id: 'dp', 'aria-labelledby': 'dp-title' });
  const bar = h('div', { class: 'dp-bar' });
  const title = h('h2', { id: 'dp-title', class: 'dp-h', tabindex: '-1' }, say('title'));
  const barBtns = h('div', { class: 'dp-bar-btns' });
  const detailBtn = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-detail' }, say('detail'));
  const backBtn = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-back' }, say('close'));
  barBtns.append(detailBtn, backBtn); bar.append(title, barBtns);
  const testNote = h('p', { class: 'dp-note', role: 'note', id: 'dp-test' }, say('testOnly'));
  const resume = h('div', { class: 'dp-resume', id: 'dp-resume', role: 'status', hidden: '' });
  const live = h('p', { class: 'dp-live', id: 'dp-live', role: 'status', 'aria-live': 'polite' });
  const err = h('p', { class: 'dp-error', id: 'dp-error', role: 'alert' });
  const stage = h('div', { class: 'dp-stage', id: 'dp-stage' });
  const veil = h('div', { class: 'dp-veil', id: 'dp-veil', 'aria-hidden': 'true' });
  veil.append(h('div', { class: 'dp-veil-card' }, ''));
  const filesIn = h('input', { type: 'file', multiple: '', id: 'dp-files', class: 'dp-hidden-input', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  const folderIn = h('input', { type: 'file', multiple: '', webkitdirectory: '', id: 'dp-folder', class: 'dp-hidden-input', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  const coverIn = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp', id: 'dp-cover-in', class: 'dp-hidden-input', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  const dialog = h('dialog', { class: 'dp-dialog', id: 'dp-confirm', 'aria-labelledby': 'dp-confirm-h' }) as HTMLDialogElement;
  shell.append(bar, testNote, resume, live, err, stage, filesIn, folderIn, coverIn, dialog);
  doc.body.append(veil);
  deps.root.prepend(shell);
  deps.root.dataset.mode = 'drop';
  const toDrop = h('button', { type: 'button', class: 'ghost dp-btn dp-to-drop', id: 'dp-to-drop' }, say('title') + ' — ' + say('emptyTitle'));
  deps.root.insertBefore(toDrop, shell.nextSibling);

  /* ── 초안 ── */
  const readDraft = (): Draft | null => { try { const t = store?.getItem(DROP_DRAFT_KEY); const d = t ? JSON.parse(t) as Draft : null; return d?.v === 1 ? d : null; } catch { return null; } };
  const saveDraft = () => {
    if (!guess && !published) return;
    if (state === 'done') return;
    const d: Draft = { v: 1, type, format, fields, look, genre, tracks, fileShas: [...content, ...(cover ? [cover] : [])].map(f => sha256Hex(f.bytes)),
      cache: [...cache.entries()], savedAt: now().toISOString(), published };
    try { store?.setItem(DROP_DRAFT_KEY, JSON.stringify(d)); } catch { /* 저장 못 해도 화면은 돈다 */ }
  };
  const dropDraft = () => { try { store?.removeItem(DROP_DRAFT_KEY); } catch { /* 없음 */ } };

  /* ── 상태 전이 ── */
  function fire(e: DropEvent) {
    const n = nextState(state, e);
    state = n; shell.dataset.state = n;
    paint();
  }
  const setMessage = (m: string) => { err.textContent = m; };
  const announce = (m: string) => { live.textContent = m; };

  /* ── 들어온 것 처리 ── */
  function revokeAll() { for (const u of urls) URL.revokeObjectURL(u); urls = []; coverUrl = null; audioUrls = new Map(); }
  const blobUrl = (f: FileInput) => { const u = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mime || undefined })); urls.push(u); return u; };

  async function accept(files: DroppedFile[], folderName: string, how: DropEvent, extraCache: PinCache | null = null) {
    if (!acceptsDrop(state)) { announce('발행하는 중에는 새로 받지 않아요.'); return; }
    setMessage(''); fire(how);
    announce(say('detecting'));
    await new Promise(r => setTimeout(r, 0));
    const g = guessDrop(files, folderName);
    if (!g.files.length && !g.cover) {
      setMessage(sayRaw(g.ignored.length ? `받을 수 있는 파일이 없어요 — ${g.ignored[0].path}: ${g.ignored[0].say}` : '놓은 것이 비어 있어요.'));
      fire('failed'); return;
    }
    const draft = readDraft();
    revokeAll(); published = null; doneInfo = null;
    guess = g; type = g.type ?? 'digital'; format = g.format; content = g.files; cover = g.cover;
    tracks = g.tracks.map(t => ({ path: t.path, title: t.title, durationMs: null }));
    if (extraCache) for (const [k, v] of extraCache) cache.set(k, v);
    else if (!(draft && draft.fileShas.length)) cache = new Map();
    // 같은 파일을 다시 놓았으면(지문이 같으면) 지난 초안의 칸·꾸밈·CID 캐시를 이어 쓴다.
    const shas = new Set([...content, ...(cover ? [cover] : [])].map(f => sha256Hex(f.bytes)));
    if (draft && draft.fileShas.length && draft.fileShas.every(s => shas.has(s)) && draft.type === type) {
      fields = { ...EMPTY_FIELDS, ...draft.fields }; look = draft.look; genre = draft.genre ?? { main: null, tags: [] }; format = draft.format; cache = new Map([...draft.cache, ...cache]);
      const order = new Map(draft.tracks.map((t, i) => [t.path, i]));
      tracks = [...tracks].sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999)).map(t => ({ ...t, title: draft.tracks.find(x => x.path === t.path)?.title ?? t.title }));
      touched = { work: true, price: true, preview: true };
      announce('지난번 칸을 이어서 채웠어요. 이미 올린 파일은 건너뛰어요.');
    } else {
      fields = { ...EMPTY_FIELDS, title: g.title, dLabel: type === 'digital' ? (content.every(f => COVER_EXT.has(extOf(f.path)) || extOf(f.path) === 'gif') ? '그림 모음' : '파일 모음') : '',
        address: fields.address };
      const p = defaultPrice(type, format); fields.price = p ? String(p) : '';
      touched = { work: false, price: false, preview: false };
      genre = { main: null, tags: [] };
      look = { template: defaultTemplate(type, format), theme: 'auto', tagline: '', coverImage: cover?.path ?? null, background: null,
        gallery: type === 'game' ? content.filter(f => COVER_EXT.has(extOf(f.path))).slice(0, 8).map(f => f.path) : [] };
    }
    if (cover) coverUrl = blobUrl(cover);
    for (const f of content) if (['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac'].includes(extOf(f.path))) audioUrls.set(f.path, blobUrl(f));
    void readDurations();
    await enterPreview(g.confidence === 'ask' ? 'unsure' : 'detected');
  }

  /** 소리 파일 길이를 읽어 곡 목록·미리듣기 기본 구간에 쓴다(못 읽으면 모름 그대로). */
  async function readDurations() {
    for (const t of tracks) {
      const u = audioUrls.get(t.path); if (!u || t.durationMs !== null) continue;
      const ms = await new Promise<number | null>(res => {
        try {
          const a = new Audio(); const done = (v: number | null) => { a.src = ''; res(v); };
          a.preload = 'metadata'; a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null); a.onerror = () => done(null);
          setTimeout(() => done(null), 3000); a.src = u;
        } catch { res(null); }
      });
      t.durationMs = ms;
    }
    if (!touched.preview && tracks[0]) { const p = defaultPreview(tracks[0].durationMs); fields.previewStart = String(p.startMs / 1000); fields.previewEnd = String(p.endMs / 1000); }
    // 칸을 다시 그리지 않는다(적는 중인 커서가 튀지 않게) — 카드·점검만.
    if (state === 'preview' || state === 'blocked') repaintSoft();
  }

  async function enterPreview(ev: DropEvent) {
    try { neighbors = (await deps.neighbors?.()) ?? []; } catch { neighbors = []; }
    if (!touched.work || !fields.work) {
      const s = suggestAsset(fields.title, type, new Set(neighbors.map(n => n.asset)), format)[0];
      if (s) fields.work = s.slice(assetPrefixFor(type).length);
    }
    if (!fields.address) {
      try { const a = await deps.invoke<unknown>('new_address', { label: 'creator' }); fields.address = typeof a === 'string' ? a : String((a as { address?: string })?.address ?? ''); }
      catch { fields.address = ''; }
    }
    fire(ev);
    // 자동으로 정한 것을 한 문장으로 알린다(묻지 않되 말해 준다).
    announce(sayRaw(guess?.reasons[0] ?? ''));
    saveDraft();
    await refreshChain();
  }

  /* ── 노드에 묻기(이름·네트워크·잔액·수수료 일정) ── */
  let seq = 0;
  async function refreshChain() {
    const my = ++seq; taken = 'checking'; paint();
    const asset = assetName();
    const [node, nt, bal] = await Promise.allSettled([
      deps.invoke<{ chain?: string; blocks?: number; headers?: number }>('node_status'), deps.invoke<unknown>('name_taken', { name: asset }), deps.invoke<{ confirmed?: number }>('wallet_balance')]);
    if (my !== seq) return;
    chain = node.status === 'fulfilled' ? String(node.value?.chain ?? 'unknown') : 'unknown';
    // 세 상태: true 있음 · false 없음 · 그 밖(오류·모르는 답) = 확인 불가. 「모름」을 「없음」으로 읽지 않는다.
    taken = nt.status === 'fulfilled' ? (nt.value === true ? true : nt.value === false ? false : null) : null;
    if (bal.status === 'fulfilled') { const a = rvnToAtoms(Number(bal.value?.confirmed ?? NaN).toFixed(8)); balanceAtoms = a === null ? null : BigInt(a); } else balanceAtoms = null;
    // 수수료 기간은 체인 높이로 정한다(마법사와 같은 규칙: 메인넷·동기화 끝난 높이만, 아니면 일정 시작 시각으로 어림).
    const st = node.status === 'fulfilled' ? node.value : null;
    chainHeight = st?.chain === 'main' && Number.isSafeInteger(st.blocks) && st.blocks! > 0 && st.blocks === st.headers ? st.blocks! : null;
    paint();
  }

  /* ── 입력 → 발행 입력값 ── */
  const assetName = () => assetPrefixFor(type) + fields.work.trim().toUpperCase();
  const num = (s: string) => Number(String(s).trim());
  const isoOf = (v: string) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
  function details(): Details {
    const paths = content.map(f => f.path);
    switch (type) {
      case 'game': return { entry: guess?.entry && paths.includes(guess.entry) ? guess.entry : paths.find(p => /\.html?$/i.test(p)) ?? '', origin: null, capabilities: { identity: false, payment: false } };
      case 'music': return { previewFile: tracks[0]?.path ?? '', previewStartMs: Math.round(num(fields.previewStart) * 1000), previewEndMs: Math.round(num(fields.previewEnd) * 1000) };
      case 'book': {
        const book = guess?.bookFile && paths.includes(guess.bookFile) ? guess.bookFile : paths.find(p => /\.(epub|pdf)$/i.test(p)) ?? '';
        const pv = guess?.bookPreview && paths.includes(guess.bookPreview) && guess.bookPreview !== book ? guess.bookPreview : null;
        return { bookFile: book, format: extOf(book) === 'epub' ? 'epub' : 'pdf', previewFile: pv, previewPages: pv ? Math.round(num(fields.bookPreviewPages)) : 0, pageCount: fields.bookPages.trim() ? Math.round(num(fields.bookPages)) : null };
      }
      case 'ticket': return { eventName: fields.tEvent.trim() || fields.title.trim(), startsAt: isoOf(fields.tStart), endsAt: isoOf(fields.tEnd) || null, venue: fields.tVenue.trim(),
        quantity: Math.round(num(fields.tQty)), redemption: { method: 'creator-signed-code', checkerAddress: fields.address.trim() }, refundPolicy: fields.tRefund.trim(), contact: fields.tContact.trim() };
      default: return { label: fields.dLabel.trim() };
    }
  }
  function gather(): PublishInput {
    const price = fields.price.trim();
    // 음악은 곡 순서대로 파일을 넣는다(매니페스트 files 순서 = 앨범 순서).
    const ordered = type === 'music' ? tracks.map(t => content.find(f => f.path === t.path)!).filter(Boolean) : content;
    return { type, asset: assetName(), title: fields.title, description: fields.description, files: [...ordered, ...(cover ? [{ ...cover, role: 'cover' as const }] : [])],
      creatorAddress: fields.address.trim(), receivingAddress: fields.address.trim(), priceAtoms: price ? (rvnToAtoms(price) ?? 'invalid') : null,
      details: details(), now: now() };
  }
  const gates = () => dropGates({ prepublished: published && !content.length ? { asset: published.manifest.asset } : null, input: gather(), nameTaken: taken, neighbors, chain, chainBurnRvn: null, balanceAtoms, pastedCids, realMainnetEnabled: REAL_MAINNET_ISSUE_ENABLED, now: now().getTime() });

  /* ── 그리기 ── */
  let lastPainted: DropState | null = null;
  function paint() {
    entering = lastPainted !== state; lastPainted = state;
    shell.dataset.state = state;
    detailBtn.hidden = state === 'publishing';
    const parts: HTMLElement[] = [];
    if (state === 'idle' || state === 'detecting') parts.push(emptyStage());
    if (state === 'ask') parts.push(askStage());
    if (['preview', 'blocked', 'confirm', 'publishing'].includes(state)) parts.push(...previewStage());
    if (state === 'done') parts.push(doneStage());
    stage.replaceChildren(...parts);
    if (state === 'confirm') openConfirm(); else if (dialog.open) dialog.close();
  }

  function emptyStage(): HTMLElement {
    const box = h('div', { class: 'dp-empty' });
    const zone = h('button', { type: 'button', class: 'dp-zone', id: 'dp-zone', 'aria-describedby': 'dp-zone-say' });
    zone.append(h('span', { class: 'dp-zone-icon', 'aria-hidden': 'true' }, '⇩'), h('span', { class: 'dp-zone-h' }, say('emptyTitle')), h('span', { class: 'dp-zone-say', id: 'dp-zone-say' }, say('emptySay')));
    zone.onclick = () => filesIn.click();
    if (state === 'detecting') { zone.setAttribute('aria-busy', 'true'); zone.querySelector('.dp-zone-h')!.textContent = say('detecting'); }
    const row = h('div', { class: 'dp-row' });
    const pick = h('button', { type: 'button', class: 'dp-btn', id: 'dp-pick' }, say('pick')); pick.onclick = () => filesIn.click();
    const pickF = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-pick-folder' }, say('pickFolder')); pickF.onclick = () => folderIn.click();
    row.append(pick, pickF);
    const paste = h('form', { class: 'dp-paste', id: 'dp-paste' });
    const lab = h('label', { for: 'dp-cid', class: 'dp-label' }, say('pasteLabel'));
    const inp = h('input', { id: 'dp-cid', type: 'text', placeholder: say('pastePlaceholder'), autocomplete: 'off', spellcheck: 'false', inputmode: 'url' }) as HTMLInputElement;
    const go = h('button', { type: 'submit', class: 'ghost dp-btn', id: 'dp-cid-go' }, say('pasteGo'));
    const prow = h('div', { class: 'dp-row dp-row-input' }); prow.append(inp, go);
    paste.append(lab, prow);
    paste.onsubmit = e => { e.preventDefault(); void pasteCid(inp.value); };
    box.append(zone, row, paste);
    return box;
  }

  function askStage(): HTMLElement {
    const box = h('div', { class: 'dp-ask card', role: 'group', 'aria-labelledby': 'dp-ask-h' });
    box.append(h('h3', { id: 'dp-ask-h' }, say('ask')), h('p', {}, sayRaw(guess?.question ?? '')));
    const opts = h('div', { class: 'dp-options', role: 'radiogroup', 'aria-labelledby': 'dp-ask-h' });
    for (const t of guess?.options ?? []) {
      const b = h('button', { type: 'button', class: 'dp-option', role: 'radio', 'aria-checked': String(t === type), 'data-kind': t }, sayRaw(kindWord(t)));
      b.onclick = () => { setKind(t); fire('answer'); saveDraft(); };
      opts.append(b);
    }
    box.append(opts);
    if (!(guess?.options ?? []).length) { const again = h('button', { type: 'button', class: 'ghost dp-btn' }, say('startOver')); again.onclick = reset; box.append(again); }
    return box;
  }

  function setKind(t: ContentType) {
    if (t === type) return;
    const wasDefault = look.template === defaultTemplate(type, format);
    type = t; format = t === 'music' ? (tracks.length === 1 ? 'single' : tracks.length <= 6 ? 'ep' : 'album') : null;
    // 사람이 고른 모양은 그대로 두고, 기본 모양이었으면 새 종류의 기본 모양으로 바꾼다.
    if (wasDefault || !templatesFor(t).includes(look.template)) look = { ...look, template: defaultTemplate(t, format) };
    if (!touched.price) { const p = defaultPrice(t, format); fields.price = p ? String(p) : ''; }
    if (!touched.work) { const s = suggestAsset(fields.title, type, new Set(neighbors.map(n => n.asset)), format)[0]; if (s) fields.work = s.slice(assetPrefixFor(type).length); }
    if (genre.main && !genresFor(t).some(x => x.id === genre.main)) genre = { ...genre, main: null };
    if (t === 'ticket' && !fields.tEvent) fields.tEvent = fields.title;
    void refreshChain();
  }

  function storeModel(): StoreModel {
    const price = fields.price.trim(), atoms = price ? rvnToAtoms(price) : null;
    const urlOf = (p: string) => { if (cover && p === cover.path) return coverUrl; const f = content.find(x => x.path === p); return f ? blobUrl(f) : null; };
    const d = details() as unknown as Record<string, unknown>;
    return {
      kind: type, title: fields.title.trim() || '—', description: fields.description, assetName: assetName(), priceRvn: atoms ? atomsToRvn(atoms) : null, format,
      tracks: tracks.map((t, i) => ({ title: t.title, durationMs: t.durationMs, previewUrl: i === 0 || look.template === 'album' ? audioUrls.get(t.path) ?? null : null })),
      coverUrl: look.coverImage ? urlOf(look.coverImage) : coverUrl, backgroundUrl: look.background ? urlOf(look.background) : null,
      galleryUrls: look.gallery.map(urlOf).filter((u): u is string => !!u),
      book: type === 'book' ? { format: d.format as 'pdf' | 'epub', pageCount: d.pageCount as number | null, previewPages: d.previewPages as number } : null,
      ticket: type === 'ticket' ? { eventName: String(d.eventName), startsAt: String(d.startsAt), venue: String(d.venue), quantity: Number(d.quantity) || 0 } : null,
      trust: 'unverified', officialLooking: false, similar: [],
    };
  }

  function previewStage(): HTMLElement[] {
    const g = gates();
    // 상태와 점검을 맞춘다: 막힘이 생기면 blocked, 풀리면 preview.
    if (state === 'preview' && !g.canPublish && taken !== 'checking') { state = 'blocked'; shell.dataset.state = state; }
    else if (state === 'blocked' && g.canPublish) { state = 'preview'; shell.dataset.state = state; }
    const out: HTMLElement[] = [];
    const head = h('p', { class: 'dp-preview-head' }, say('previewHead'));
    const model = storeModel();
    const conflict = g.chips.find(c => c.id === 'lookalike');
    model.officialLooking = !!conflict && /공식/.test(conflict.say);
    model.similar = conflict && /비슷한 이름/.test(conflict.say) ? [conflict.say.replace(/^.*비슷한 이름이 있어요: ([^.]*)\..*$/s, '$1')] : [];
    const card = renderStorefront(model, lookView(), { lang, doc, say: (k, v) => say(k, v) });
    card.id = 'dp-card';
    // 들어오는 연출은 상태가 바뀔 때만(감지 → 미리보기). 글자·모양을 고칠 때마다 다시 움직이지 않는다.
    if (entering) card.classList.add('dp-enter');
    out.push(head, card);
    if (published) out.push(h('p', { class: 'dp-note', role: 'note' }, sayRaw('파일은 이미 다 올렸어요. 발행만 남았어요.')));
    if (lockableType(type) && !published) out.push(h('p', { class: 'dp-note', role: 'note', id: 'dp-lock-note' }, sayRaw(LOCK_COPY.onLines(type)[0] + ' ' + LOCK_COPY.onLines(type)[1])));
    if (published?.manifest.lock) out.push(backupCard());
    if (!DROP_MANIFEST_V3_ENABLED && (look.template !== defaultTemplate(type, format) || look.theme !== 'auto' || look.tagline || genre.main || genre.tags.length || (type === 'music' && tracks.length > 1)))
      out.push(h('p', { class: 'dp-note', role: 'note', id: 'dp-v3-note' }, sayRaw('꾸밈(모양·색·한 줄 소개)·장르·태그와 곡 목록은 지금은 내 화면 미리보기에만 있어요. 구매자 지갑이 새 상품 정보(v3)를 읽게 된 뒤에 함께 실려요.')));
    if (!(published && !content.length)) out.push(decorate());
    out.push(chipsBox(g.chips));
    // 비용 한 줄 + 발행 단추
    const pr = fields.price.trim(), atoms = pr ? rvnToAtoms(pr) : null;
    // 수수료는 서명된 일정(트렁크 규칙)에서. 일정을 아직 못 받았으면 정책 출발값을 「일정 받기 전」으로 보이고 판매는 닫혀 있다.
    const schedule = deps.feeSchedule?.() ?? null, addr = fields.address.trim();
    const n = feeNotice(atoms, { schedule, kind: type, height: chainHeight, now: now().getTime(),
      seller: isRvnAddress(addr) ? { address: addr, receivingAddress: addr } : null });
    const feePct = n.percent ?? bpsPercent(ruleFor(policySchedule({ launchHeight: 1, launchTimeNote: '2026-01-01T00:00:00Z' }), type).bps);
    const feeSource = say(n.scheduled ? 'feeSrcSigned' : 'feeSrcPending');
    const cost = h('p', { class: 'dp-cost', id: 'dp-cost' }, atoms
      ? say('costLine', { burn: 500, net: atomsToRvn(NETWORK_FEE_FALLBACK_ATOMS), fee: feePct, feeSource })
      : say('costLineFree', { burn: 500, net: atomsToRvn(NETWORK_FEE_FALLBACK_ATOMS) }));
    const act = h('div', { class: 'dp-act' });
    const pub = h('button', { type: 'button', class: 'dp-publish', id: 'dp-publish' }, state === 'publishing' ? say('publishing') : say('publish')) as HTMLButtonElement;
    pub.disabled = !g.canPublish || busy || state === 'publishing';
    const why = h('p', { class: 'dp-why', id: 'dp-why', role: 'status' }, g.blockers.length ? sayRaw(`${say('blockedTitle')}: ${g.blockers[0].say}${g.blockers[0].next ? ' → ' + g.blockers[0].next : ''}`) : '');
    pub.setAttribute('aria-describedby', 'dp-cost dp-why');
    pub.onclick = () => { if (gates().canPublish) fire('publish'); };
    act.append(pub);
    if (state === 'publishing') {
      const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
      const bar = h('div', { class: 'dp-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': say('publishing') });
      const fill = h('span'); fill.style.width = pct + '%'; bar.append(fill);
      act.append(bar, h('p', { class: 'dp-note' }, sayRaw(progress.path ? `${progress.done}/${progress.total} · ${progress.path}` : '닫아도 다음에 이어서 할 수 있어요.')));
    }
    // 붙여 넣은 상품 정보(이미 서명·보관됨)는 고칠 수 없다 — 고치려면 파일을 놓아 새로 만든다.
    out.push(cost, act, why);
    if (!(published && !content.length)) out.push(advanced());
    return out;
  }

  function backupCard(): HTMLElement {
    const box = h('section', { class: 'dp-checks', id: 'dp-lock-backup' });
    const done = readBackups(store)[published!.manifest.asset];
    box.append(h('p', { class: done ? 'dp-note' : 'dp-why', role: 'status', id: 'dp-lock-backup-say' }, sayRaw(done ? LOCK_COPY.backupHead : LOCK_COPY.backupMissing)));
    box.append(h('p', { class: 'dp-hint' }, sayRaw('이 열쇠를 잃으면 나도 이 상품의 파일을 열 수 없고, 구매자에게 열람 키를 보내 줄 수도 없어요. 복구할 방법이 없어요.')));
    const b = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-lock-save' }, sayRaw('열쇠 파일 저장(폴더 고르기)'));
    b.onclick = async () => {
      const asset = published!.manifest.asset;
      try {
        const folder = await deps.pickFolder?.();
        if (!folder) { setMessage(sayRaw('폴더를 고르지 않았어요 → 다시 눌러 iCloud·USB 같은 곳을 골라 주세요.')); return; }
        await saveKeyFile(deps.invoke, asset, folder);
        markBackedUp(store, asset, now().toISOString()); setMessage(''); paint();
      } catch (e) { setMessage(sayRaw(`열쇠 파일을 저장하지 못했어요(${errText(e)}) → 다른 폴더를 골라 다시 눌러 주세요.`)); }
    };
    box.append(b);
    return box;
  }

  function chipsBox(chips: Chip[]): HTMLElement {
    const box = h('section', { class: 'dp-checks', 'aria-labelledby': 'dp-checks-h' });
    box.append(h('h3', { id: 'dp-checks-h', class: 'dp-h3' }, say('checks')));
    const ul = h('ul', { class: 'dp-chips', id: 'dp-chips' });
    for (const c of chips) {
      const li = h('li', { class: 'dp-chip', 'data-status': c.status, 'data-id': c.id });
      li.append(h('span', { class: 'dp-chip-tag' }, say(c.status)), h('span', { class: 'dp-chip-say' }, sayRaw(c.say + (c.next && c.status !== 'pass' ? ' → ' + c.next : ''))));
      if (c.id === 'chain-name' && c.status === 'block' && taken !== 'checking') {
        const re = h('button', { type: 'button', class: 'ghost dp-btn dp-mini', id: 'dp-recheck' }, sayRaw('다시 조회')); re.onclick = () => void refreshChain(); li.append(re);
      }
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  /** 꾸미기: 모양(템플릿)·색 — 펼치지 않아도 보이는 한 줄. */
  function decorate(): HTMLElement {
    const box = h('section', { class: 'dp-decorate', 'aria-label': say('template') });
    const tl = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': say('template') });
    for (const id of templatesFor(type)) {
      const b = h('button', { type: 'button', class: 'dp-pill', role: 'radio', 'aria-checked': String(look.template === id), 'data-template': id }, sayRaw(TEMPLATES[id].label));
      b.onclick = () => { look = { ...look, template: id as TemplateId }; saveDraft(); paint(); focusSel(`.dp-pill[data-template="${id}"]`); };
      tl.append(b);
    }
    const th = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': say('theme') });
    for (const id of THEME_IDS) {
      const b = h('button', { type: 'button', class: 'dp-swatch', role: 'radio', 'aria-checked': String(look.theme === id), 'data-theme-id': id, 'aria-label': sayRaw(THEME_LABEL(id)), title: THEME_LABEL(id) });
      const dot = h('span', { class: 'dp-dot', 'aria-hidden': 'true' });
      if (id !== 'auto') { dot.style.background = THEMES[id].bg; dot.style.borderColor = THEMES[id].accent; dot.style.boxShadow = `inset 0 -10px 0 ${THEMES[id].accent}`; }
      b.append(dot, h('span', { class: 'dp-swatch-label' }, sayRaw(THEME_LABEL(id))));
      b.onclick = () => { look = { ...look, theme: id as ThemeId }; saveDraft(); paint(); focusSel(`[data-theme-id="${id}"]`); };
      th.append(b);
    }
    // 장르: 한 번 탭으로 고른다. 라비 추천은 「제안」 단추 — 눌러야 적용된다.
    const gr = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': say('genre') });
    const sug = suggestGenre(type, { title: fields.title, description: fields.description, files: content.map(f => f.path) });
    if (sug && genre.main !== sug.id) {
      const b = h('button', { type: 'button', class: 'dp-pill dp-ravi', id: 'dp-genre-suggest', 'data-genre': sug.id }, sayRaw(`라비 추천: ${sug.label} — ${sug.why}`));
      b.onclick = () => { genre = { ...genre, main: sug.id }; saveDraft(); paint(); focusSel(`.dp-pill[data-genre="${sug.id}"][role="radio"]`); };
      gr.append(b);
    }
    for (const x of genresFor(type)) {
      const b = h('button', { type: 'button', class: 'dp-pill', role: 'radio', 'aria-checked': String(genre.main === x.id), 'data-genre': x.id }, sayRaw(lang === 'ko' ? x.ko : x.en));
      b.onclick = () => { genre = { ...genre, main: genre.main === x.id ? null : x.id }; saveDraft(); paint(); focusSel(`.dp-pill[data-genre="${x.id}"][role="radio"]`); };
      gr.append(b);
    }
    box.append(h('h3', { class: 'dp-h3' }, say('genre')), gr, h('h3', { class: 'dp-h3' }, say('template')), tl, h('h3', { class: 'dp-h3' }, say('theme')), th);
    return box;
  }
  const lookView = () => ({ ...look, tags: genre.tags, genre: genre.main ? genreLabel(type, genre.main, lang === 'ko' ? 'ko' : 'en') : undefined });
  const focusSel = (sel: string) => (stage.querySelector(sel) as HTMLElement | null)?.focus();

  let advOpen = false;
  function advanced(): HTMLElement {
    const det = h('details', { class: 'dp-adv', id: 'dp-adv' }) as HTMLDetailsElement;
    det.open = advOpen; det.ontoggle = () => { advOpen = det.open; };
    det.append(h('summary', { class: 'dp-summary' }, say('advanced')));
    const body = h('div', { class: 'dp-adv-body' });
    const field = (id: string, label: string, value: string, set: (v: string) => void, opts: { type?: string; area?: boolean; max?: number; hint?: string } = {}) => {
      const wrap = h('div', { class: 'dp-field' });
      const lab = h('label', { for: id }, sayRaw(label));
      const e = (opts.area ? h('textarea', { id, rows: '3' }) : h('input', { id, type: opts.type ?? 'text', autocomplete: 'off' })) as HTMLInputElement;
      if (opts.max) e.maxLength = opts.max;
      e.value = value;
      e.addEventListener('input', () => { set(e.value); saveDraft(); repaintSoft(); });
      e.addEventListener('change', () => { paint(); focusSel('#' + id); });
      wrap.append(lab, e);
      if (opts.hint) wrap.append(h('p', { class: 'dp-hint' }, sayRaw(opts.hint)));
      return wrap;
    };
    // 종류
    const kind = h('div', { class: 'dp-field' });
    const kl = h('label', { for: 'dp-kind' }, say('kind'));
    const ks = h('select', { id: 'dp-kind' }) as HTMLSelectElement;
    for (const t of ['music', 'book', 'game', 'ticket', 'digital'] as ContentType[]) ks.append(new Option(kindWord(t), t, false, t === type));
    ks.onchange = () => { setKind(ks.value as ContentType); saveDraft(); paint(); focusSel('#dp-kind'); };
    kind.append(kl, ks); body.append(kind);
    body.append(field('dp-title-in', say('titleField'), fields.title, v => { fields.title = v; if (!touched.work) { const s = suggestAsset(v, type, new Set(neighbors.map(n => n.asset)), format)[0]; if (s) fields.work = s.slice(assetPrefixFor(type).length); } }, { max: 80 }));
    body.append(field('dp-tagline', say('tagline'), look.tagline, v => { look = { ...look, tagline: v.trim().slice(0, 80) }; }, { max: 80 }));
    body.append(field('dp-desc', say('description'), fields.description, v => { fields.description = v; }, { area: true, max: 2000 }));
    body.append(field('dp-tags', say('tags'), genre.tags.join(', '), v => { genre = { ...genre, tags: parseGenreTags(v) }; }));
    body.append(field('dp-price', say('price'), fields.price, v => { fields.price = v; touched.price = true; }, { type: 'text', hint: '가격을 비우면 무료예요. 게임은 검증되기 전에는 지갑 결제가 안 돼요.' }));
    // 이름
    const nm = h('div', { class: 'dp-field' });
    nm.append(h('label', { for: 'dp-work' }, say('name')));
    const nrow = h('div', { class: 'dp-name-row' });
    const ni = h('input', { id: 'dp-work', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '28' }) as HTMLInputElement;
    ni.value = fields.work;
    ni.addEventListener('input', () => { fields.work = ni.value.toUpperCase(); touched.work = true; saveDraft(); });
    ni.addEventListener('change', () => { paint(); focusSel('#dp-work'); void refreshChain(); });
    nrow.append(h('code', { class: 'dp-prefix', 'aria-hidden': 'true' }, assetPrefixFor(type)), ni);
    nm.append(nrow);
    const sug = h('div', { class: 'dp-pick-row', 'aria-label': '이름 제안' });
    for (const s of suggestAsset(fields.title, type, new Set(neighbors.map(n => n.asset)), format)) {
      const b = h('button', { type: 'button', class: 'dp-pill dp-mono' }, s); b.onclick = () => { fields.work = s.slice(assetPrefixFor(type).length); touched.work = true; saveDraft(); paint(); void refreshChain(); };
      sug.append(b);
    }
    nm.append(sug, h('p', { class: 'dp-hint' }, sayRaw('상품 등록증 이름은 영구예요. 앞부분은 종류로 정해지고, 영문 대문자·숫자·점·밑줄만 돼요.')));
    body.append(nm);
    // 받을 주소
    const ad = h('div', { class: 'dp-field' });
    ad.append(h('label', { for: 'dp-address' }, sayRaw('판매 대금 받을 내 주소')));
    const arow = h('div', { class: 'dp-row dp-row-input' });
    const ai = h('input', { id: 'dp-address', type: 'text', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement; ai.value = fields.address;
    ai.addEventListener('input', () => { fields.address = ai.value.trim(); saveDraft(); });
    ai.addEventListener('change', () => { paint(); focusSel('#dp-address'); });
    const an = h('button', { type: 'button', class: 'ghost dp-btn' }, sayRaw('새 주소 받기'));
    an.onclick = async () => { try { const a = await deps.invoke<unknown>('new_address', { label: 'creator' }); fields.address = typeof a === 'string' ? a : String((a as { address?: string })?.address ?? ''); saveDraft(); paint(); } catch (e) { setMessage(sayRaw(`주소를 받지 못했어요(${errText(e)}) → 지갑이 열려 있는지 확인해 주세요.`)); } };
    arow.append(ai, an); ad.append(arow); body.append(ad);
    // 표지 끌어놓기
    if (type !== 'game') {
      const cz = h('button', { type: 'button', class: 'dp-cover-zone', id: 'dp-cover-zone' });
      cz.append(h('span', {}, say('coverDrop')), h('span', { class: 'dp-hint' }, cover ? cover.path : ''));
      cz.onclick = () => coverIn.click();
      cz.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); cz.classList.add('over'); });
      cz.addEventListener('dragleave', () => cz.classList.remove('over'));
      cz.addEventListener('drop', async e => { e.preventDefault(); e.stopPropagation(); cz.classList.remove('over'); const { files } = await readDataTransfer(e.dataTransfer!); if (files[0]) setCover(files[0]); });
      body.append(cz);
    }
    // 종류별
    if (type === 'music') {
      const fs = h('fieldset', { class: 'dp-tracks' }); fs.append(h('legend', {}, say('trackOrder')));
      const fm = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': 'format' });
      for (const f of ['single', 'ep', 'album'] as MusicFormat[]) {
        const b = h('button', { type: 'button', class: 'dp-pill', role: 'radio', 'aria-checked': String(format === f), 'data-format': f }, say(`format_${f}` as CopyKey));
        b.onclick = () => { format = f; if (templatesFor('music').includes(look.template)) look = { ...look, template: defaultTemplate('music', f) }; saveDraft(); paint(); focusSel(`[data-format="${f}"]`); };
        fm.append(b);
      }
      fs.append(fm);
      const ol = h('ol', { class: 'dp-track-list' });
      tracks.forEach((t, i) => {
        const li = h('li');
        const ti = h('input', { type: 'text', id: `dp-track-${i}`, 'aria-label': `${i + 1}`, maxlength: '80' }) as HTMLInputElement; ti.value = t.title;
        ti.addEventListener('input', () => { t.title = ti.value; saveDraft(); repaintSoft(); });
        const up = h('button', { type: 'button', class: 'ghost dp-btn dp-mini', 'aria-label': `${say('up')} — ${t.title}` }, '↑'); up.disabled = i === 0;
        const dn = h('button', { type: 'button', class: 'ghost dp-btn dp-mini', 'aria-label': `${say('down')} — ${t.title}` }, '↓'); dn.disabled = i === tracks.length - 1;
        up.onclick = () => { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; saveDraft(); paint(); focusSel(`#dp-track-${i - 1}`); };
        dn.onclick = () => { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; saveDraft(); paint(); focusSel(`#dp-track-${i + 1}`); };
        li.append(ti, up, dn); ol.append(li);
      });
      fs.append(ol);
      const pr = h('div', { class: 'dp-row dp-row-2' });
      pr.append(field('dp-pv-start', say('previewRange') + ' ▸', fields.previewStart, v => { fields.previewStart = v; touched.preview = true; }, { type: 'number' }),
        field('dp-pv-end', say('previewRange') + ' ◂', fields.previewEnd, v => { fields.previewEnd = v; touched.preview = true; }, { type: 'number' }));
      fs.append(pr, h('p', { class: 'dp-hint' }, sayRaw('미리듣기는 첫 곡에서 1초~60초. 곡 순서를 바꾸면 첫 곡이 바뀌어요.')));
      body.append(fs);
    }
    if (type === 'book') {
      body.append(field('dp-book-pages', '전체 쪽수(선택)', fields.bookPages, v => { fields.bookPages = v; }, { type: 'number' }));
      if ((details() as { previewFile: string | null }).previewFile) body.append(field('dp-book-pv', '미리보기 쪽수(1~50)', fields.bookPreviewPages, v => { fields.bookPreviewPages = v; }, { type: 'number' }));
    }
    if (type === 'ticket') {
      body.append(field('dp-t-event', '행사 이름', fields.tEvent, v => { fields.tEvent = v; }, { max: 80 }),
        field('dp-t-start', '시작', fields.tStart, v => { fields.tStart = v; }, { type: 'datetime-local' }),
        field('dp-t-end', '끝(선택)', fields.tEnd, v => { fields.tEnd = v; }, { type: 'datetime-local' }),
        field('dp-t-venue', '장소', fields.tVenue, v => { fields.tVenue = v; }, { max: 200 }),
        field('dp-t-qty', '판매 수량', fields.tQty, v => { fields.tQty = v; }, { type: 'number' }),
        field('dp-t-refund', '환불 규정', fields.tRefund, v => { fields.tRefund = v; }, { area: true, max: 1000 }),
        field('dp-t-contact', '연락처', fields.tContact, v => { fields.tContact = v; }, { max: 200 }));
    }
    if (type === 'digital') body.append(field('dp-d-label', '상품 종류 한 줄(예: 그림 모음)', fields.dLabel, v => { fields.dLabel = v; }, { max: 40 }));
    const ren = guess?.renamed ?? [], ign = guess?.ignored ?? [];
    if (ren.length || ign.length) {
      const ul = h('ul', { class: 'dp-hint dp-files-note' });
      for (const r of ren.slice(0, 20)) ul.append(h('li', {}, sayRaw(`이름을 바꿨어요: ${r.from} → ${r.to}`)));
      for (const r of ign.slice(0, 20)) ul.append(h('li', {}, sayRaw(`넣지 않았어요: ${r.path} — ${r.say}`)));
      body.append(ul);
    }
    det.append(body);
    return det;
  }
  /** 글자를 적는 동안에는 칸을 다시 그리지 않고(커서가 튄다) 미리보기·점검만 새로 그린다. */
  function repaintSoft() {
    const card = stage.querySelector('#dp-card');
    if (card) {
      const g = gates(), model = storeModel();
      const fresh = renderStorefront(model, lookView(), { lang, doc, say: (k, v) => say(k, v) }); fresh.id = 'dp-card'; card.replaceWith(fresh);
      const box = stage.querySelector('.dp-checks'); if (box) box.replaceWith(chipsBox(g.chips));
      const pub = stage.querySelector<HTMLButtonElement>('#dp-publish'); if (pub) pub.disabled = !g.canPublish || busy || state === 'publishing';
      const why = stage.querySelector('#dp-why'); if (why) why.textContent = g.blockers.length ? sayRaw(`${say('blockedTitle')}: ${g.blockers[0].say}${g.blockers[0].next ? ' → ' + g.blockers[0].next : ''}`) : '';
    }
  }
  function setCover(f: DroppedFile) {
    const ext = extOf(f.path);
    if (!COVER_EXT.has(ext)) { setMessage(sayRaw('표지는 PNG·JPG·WEBP 만 돼요.')); return; }
    const s = sniff(f.bytes);
    if (!(s === ext || (s === 'jpg' && ext === 'jpeg'))) { setMessage(sayRaw('표지 파일 이름(확장자)과 실제 내용이 달라요.')); return; }
    const path = 'cover.' + ext;
    if (content.some(c => c.path.toLowerCase() === path)) { setMessage(sayRaw('같은 이름의 파일이 이미 있어요.')); return; }
    cover = { path, bytes: f.bytes, mime: f.mime ?? '', role: 'cover' }; coverUrl = blobUrl(cover); look = { ...look, coverImage: path }; published = null;
    setMessage(''); saveDraft(); paint();
  }

  /* ── 확인 창(되돌릴 수 없다는 한 번만) ── */
  function openConfirm() {
    const inp = gather();
    const plan = planIssue({ asset: inp.asset, manifestCid: '', chain, ownedAssets: [], nameTaken: taken === 'checking' ? null : taken, chainBurnRvn: null, typedName: inp.asset, type });
    const c = costPlan({ burnRvn: plan.burn.rvn, networkFeeAtoms: null, balanceAtoms });
    dialog.replaceChildren();
    dialog.append(h('h2', { id: 'dp-confirm-h' }, say('confirmTitle')));
    const nm = h('p', { class: 'dp-confirm-name' }); nm.append(h('code', { translate: 'no' }, inp.asset)); dialog.append(nm);
    const ul = h('ul', { class: 'dp-confirm-list' });
    for (const line of [...c.lines.slice(0, 3), ...plan.irreversible]) ul.append(h('li', {}, sayRaw(line)));
    dialog.append(ul);
    const row = h('div', { class: 'dp-row dp-row-end' });
    const cancel = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-confirm-cancel' }, say('confirmCancel'));
    const go = h('button', { type: 'button', class: 'dp-btn dp-danger', id: 'dp-confirm-go' }, say('confirmGo'));
    cancel.onclick = () => { fire('cancel'); focusSel('#dp-publish'); };
    go.onclick = () => { fire('confirm'); void runPublish(); };
    dialog.onclose = () => { if (state === 'confirm') fire('cancel'); };
    row.append(cancel, go); dialog.append(row);
    if (!dialog.open) { try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); } }
    cancel.focus();
  }

  /* ── 발행 ── */
  async function runPublish() {
    if (busy) return;
    busy = true; setMessage(''); progress = { done: 0, total: 0, path: '' }; paint();
    try {
      await refreshChain();
      state = 'publishing'; // refreshChain 이 그리는 동안 상태가 바뀌지 않게 다시 못박는다.
      const g = gates();
      if (!g.canPublish) { busy = false; fire('blocked'); return; }
      let inp = gather();
      if (!published) {
        // 열람 보호: 음악·책·그 밖의 디지털 상품은 파일을 암호화해서 올린다(미리듣기·미리보기만 따로 잘라 평문). 새 상품 정보(v3) 경로는 아직 꺼져 있어 암호화를 지원하지 않는다.
        if (lockableType(inp.type) && !DROP_MANIFEST_V3_ENABLED) { const prep = await lockedInputFor(deps.invoke, inp, { makeClip: deps.makeClip }); inp = prep.input; if (prep.notes.length) setMessage(sayRaw(prep.notes.join(' '))); }
        const onProgress = (p: { done: number; total: number; path: string }) => { progress = p; const bar = stage.querySelector('.dp-progress'); if (bar) { const pct = Math.round(p.done / p.total * 100); bar.setAttribute('aria-valuenow', String(pct)); (bar.firstElementChild as HTMLElement).style.width = pct + '%'; } announce(`${p.done}/${p.total} · ${p.path}`); saveDraft(); };
        if (DROP_MANIFEST_V3_ENABLED) {
          const lk = { ...look, imageFiles: [] as FileInput[] };
          const r = await publishV3(inp, { genre, look: lk, music: type === 'music' ? musicExtFrom(format ?? 'single', tracks, { startMs: (inp.details as MusicSection).previewStartMs ?? 0, endMs: (inp.details as MusicSection).previewEndMs ?? 0 }) : null }, pin, sign, { cache, onProgress });
          published = { manifestCid: r.manifestCid, manifestSha256: r.manifestSha256, manifest: r.manifest as unknown as CreatorManifest, pinnedBy: r.pinnedBy };
        } else {
          const r = await publishContent(inp, pin, sign, { cache, onProgress });
          published = { manifestCid: r.manifestCid, manifestSha256: r.manifestSha256, manifest: r.manifest, pinnedBy: r.pinnedBy };
        }
        saveDraft();
      }
      if (needsBackup()) {
        setMessage(sayRaw(LOCK_COPY.backupMissing)); busy = false; fire('blocked'); return;
      }
      // 최종 판정 = core planIssue(마법사와 같은 함수). 사람이 이름을 다시 적는 칸 대신 확인 창 한 번(설계 §6).
      const plan = planIssue({ asset: published.manifest.asset, manifestCid: published.manifestCid, chain, ownedAssets: [], nameTaken: taken === 'checking' ? null : taken,
        chainBurnRvn: null, typedName: published.manifest.asset, realMainnetEnabled: REAL_MAINNET_ISSUE_ENABLED, type: published.manifest.type });
      const c = costPlan({ burnRvn: plan.burn.rvn, networkFeeAtoms: null, balanceAtoms });
      if (!plan.canIssue || c.enough === false) {
        setMessage(sayRaw(`${say('blockedTitle')}: ${plan.blockers[0] ?? '잔액이 모자라요.'} 올린 파일은 그대로예요 — 고친 뒤 다시 「발행」을 누르면 이어서 해요.`));
        busy = false; fire('blocked'); return;
      }
      const { txid } = await issuer.issue(plan.params);
      const m = published.manifest;
      buildListingRequest({ manifest: m, manifestCid: published.manifestCid, manifestSha256: published.manifestSha256, issueTxid: txid, now: now() });
      const item: MineItem = { asset: m.asset, title: m.title, type: m.type, manifestCid: published.manifestCid, txid, receivingAddress: m.creator.receivingAddress, at: now().toISOString() };
      try { const old = JSON.parse(store?.getItem(MINE_KEY) ?? '[]') as MineItem[]; store?.setItem(MINE_KEY, JSON.stringify([item, ...old.filter(x => x.asset !== item.asset)].slice(0, 200))); } catch { /* 목록 저장 실패는 화면을 막지 않는다 */ }
      doneInfo = { asset: m.asset, txid, share: [`「${m.title}」을(를) 레이븐볼트 열린 장터에 올렸어요.`, `상품 등록증 이름: ${m.asset}`, `매니페스트: ipfs://${published.manifestCid}`].join('\n') };
      dropDraft(); published = null; cache = new Map(); busy = false;
      fire('issued'); announce(say('doneTitle'));
      (stage.querySelector('#dp-done-h') as HTMLElement | null)?.focus();
    } catch (e) {
      busy = false;
      setMessage(sayRaw(`발행하지 못했어요(${errText(e)}) → IPFS·노드가 켜져 있는지 확인하고 「발행」을 다시 눌러 주세요. 이미 올린 파일은 건너뛰어요.`));
      saveDraft(); fire('failed');
    }
  }

  function doneStage(): HTMLElement {
    const box = h('div', { class: 'dp-done card' });
    box.append(h('h3', { id: 'dp-done-h', tabindex: '-1' }, say('doneTitle')), h('p', {}, say('doneSay', { name: doneInfo?.asset ?? '' })));
    const tx = h('p', { class: 'dp-hint' }); tx.append(sayRaw('거래 번호: '), h('code', { id: 'dp-txid' }, doneInfo?.txid ?? '')); box.append(tx);
    const share = h('textarea', { id: 'dp-share', rows: '3', readonly: '', 'aria-label': 'share' }) as HTMLTextAreaElement; share.value = doneInfo?.share ?? '';
    const row = h('div', { class: 'dp-row' });
    const cp = h('button', { type: 'button', class: 'ghost dp-btn' }, sayRaw('알림 글 복사')); cp.onclick = () => void navigator.clipboard?.writeText(share.value).catch(() => undefined);
    const again = h('button', { type: 'button', class: 'dp-btn', id: 'dp-again' }, say('startOver')); again.onclick = reset;
    row.append(cp, again); box.append(share, row);
    return box;
  }

  function reset() { revokeAll(); guess = null; content = []; cover = null; tracks = []; fields = { ...EMPTY_FIELDS, address: fields.address }; published = null; pastedCids = []; setMessage(''); fire('reset'); focusSel('#dp-zone'); }

  /* ── IPFS 주소 붙여넣기 ── */
  async function pasteCid(text: string) {
    const p = parsePastedCid(text);
    if (!p.ok) { setMessage(sayRaw(p.say)); return; }
    setMessage(''); announce(say('detecting'));
    let alive = false;
    try { alive = await probe(p.cid); } catch { alive = false; }
    if (!alive) { setMessage(sayRaw(`이 주소(${p.cid})는 지금 받을 수 없어요 → 받아지지 않는 주소로는 팔 수 없어요. 그 파일을 가진 컴퓨터·IPFS 를 켜 두고 다시 붙여 넣어 주세요.`)); return; }
    let bytes: Uint8Array;
    try { bytes = b64bytes((await deps.invoke<{ data: string }>('creator_cid_read', { cid: p.cid }))?.data ?? ''); } catch (e) { setMessage(sayRaw(`이 주소의 내용을 받지 못했어요(${errText(e)}) → 다시 시도하거나 파일을 직접 놓아 주세요.`)); return; }
    if (!bytes.length) { setMessage(sayRaw('빈 내용이에요.')); return; }
    // 상품 정보(매니페스트)면: 파일은 이미 올라가 있다 → 서명 확인 후 발행만.
    let manifest: CreatorManifest | null = null;
    if (bytes[0] === 0x7b) { try { manifest = readManifestAny(bytes).manifest as CreatorManifest; } catch (e) { setMessage(sayRaw(`상품 정보로 읽었지만 확인에 실패했어요(${errText(e)}) → 서명·형식이 맞는 상품 정보만 받아요.`)); return; } }
    if (manifest) {
      fire('paste');
      const all = [...manifest.files, ...(manifest.cover ? [manifest.cover] : [])];
      pastedCids = [{ cid: p.cid, alive: true }, ...all.slice(0, 50).map(f => ({ cid: f.cid, alive: null as boolean | null }))];
      revokeAll(); guess = null; type = manifest.type; format = null; content = []; cover = null; tracks = [];
      fields = { ...EMPTY_FIELDS, title: manifest.title, description: manifest.description, work: manifest.asset.slice(assetPrefixFor(type).length), price: manifest.price ? atomsToRvn(manifest.price.atoms) : '', address: manifest.creator.address };
      touched = { work: true, price: true, preview: true };
      look = { ...look, template: defaultTemplate(type), coverImage: null };
      published = { manifestCid: p.cid, manifestSha256: sha256Hex(bytes), manifest, pinnedBy: '붙여 넣은 주소(이미 보관됨)' };
      fire('detected'); saveDraft(); await refreshChain();
      for (const c of pastedCids) if (c.alive === null) { try { c.alive = await probe(c.cid); } catch { c.alive = false; } }
      paint(); return;
    }
    const kind = sniff(bytes);
    if (!kind || kind === 'executable' || kind === 'zip') { setMessage(sayRaw('이 주소의 내용은 상품으로 팔 수 있는 파일이 아니에요(종류를 알 수 없거나 실행·압축 파일).')); return; }
    const ext = kind === 'jpg' ? 'jpg' : kind;
    const extra: PinCache = new Map([[sha256Hex(bytes), { cid: p.cid, size: bytes.length }]]);
    pastedCids = [{ cid: p.cid, alive: true }];
    await accept([{ path: `ipfs-${p.cid.slice(2, 10).toLowerCase()}.${ext}`, bytes, mime: '' }], '', 'paste', extra);
  }

  /* ── 드롭(데스크탑 경로 / 브라우저 DataTransfer) ── */
  async function dropPaths(paths: string[]) {
    if (!paths.length) return;
    setMessage('');
    const files: DroppedFile[] = []; let folderName = '';
    try {
      for (const root of paths.slice(0, 50)) {
        const l = await deps.invoke<{ folder: boolean; name: string; files: Array<{ rel: string; size: number }> }>('creator_dropped_list', { path: root });
        if (l.folder && paths.length === 1) folderName = l.name;
        for (const f of l.files) {
          const r = await deps.invoke<{ data: string }>('creator_dropped_read', { root, rel: f.rel });
          files.push({ path: f.rel ? (paths.length === 1 ? f.rel : `${l.name}/${f.rel}`) : l.name, bytes: b64bytes(r.data) });
        }
      }
    } catch (e) { setMessage(sayRaw(`놓은 파일을 읽지 못했어요(${errText(e)}) → 다시 놓거나 「파일 고르기」로 골라 주세요.`)); return; }
    await accept(files, folderName, 'drop');
  }
  async function dropFiles(files: DroppedFile[], folderName = '') { await accept(files, folderName, 'drop'); }

  filesIn.onchange = async () => { const r = await readInputFiles(filesIn.files, false); filesIn.value = ''; if (r.files.length) await accept(r.files, r.folderName, 'pick'); };
  folderIn.onchange = async () => { const r = await readInputFiles(folderIn.files, true); folderIn.value = ''; if (r.files.length) await accept(r.files, r.folderName, 'pick'); };
  coverIn.onchange = async () => { const r = await readInputFiles(coverIn.files, false); coverIn.value = ''; if (r.files[0]) setCover(r.files[0]); };

  // 브라우저 드롭(HTML5): 이 화면이 보일 때 창 어디에 놓아도 받는다.
  const visible = () => shell.isConnected && !deps.root.hidden && deps.root.dataset.mode === 'drop' && deps.root.classList.contains('on');
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  let depth = 0;
  const veilOn = (on: boolean) => {
    veil.classList.toggle('on', on && acceptsDrop(state));
    const card = veil.firstElementChild as HTMLElement;
    card.replaceChildren(h('strong', {}, say('overlay')), h('span', {}, say('overlaySay')));
  };
  doc.addEventListener('dragenter', e => { if (!visible() || !hasFiles(e)) return; depth++; e.preventDefault(); veilOn(true); });
  doc.addEventListener('dragover', e => { if (!visible() || !hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = acceptsDrop(state) ? 'copy' : 'none'; });
  doc.addEventListener('dragleave', e => { if (!visible()) return; depth = Math.max(0, depth - 1); if (!depth || !e.relatedTarget) veilOn(false); });
  doc.addEventListener('drop', async e => {
    if (!visible() || !e.dataTransfer || e.defaultPrevented) return;
    e.preventDefault(); depth = 0; veilOn(false);
    const { files, folderName } = await readDataTransfer(e.dataTransfer);
    if (files.length) await accept(files, folderName, 'drop');
  });
  // 붙여넣기 키: 입력칸 밖에서 ipfs 주소나 파일을 붙여 넣어도 받는다.
  doc.addEventListener('paste', e => {
    if (!visible()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'dp-cid') return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) { e.preventDefault(); void Promise.all(files.map(async f => ({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type }))).then(fs => accept(fs, '', 'drop')); return; }
    const text = e.clipboardData?.getData('text') ?? '';
    if (t?.id !== 'dp-cid' && parsePastedCid(text).ok) { e.preventDefault(); void pasteCid(text); }
  });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && veil.classList.contains('on')) veilOn(false); });

  /* ── 모드 전환 ── */
  function showWizard() {
    deps.root.dataset.mode = 'wizard';
    deps.openWizard?.(guess || cover ? { type, content: type === 'music' ? tracks.map(t => content.find(f => f.path === t.path)!).filter(Boolean) : content, cover: cover ? [{ ...cover, role: 'cover' }] : [], fields: wizardFields() } : null);
    toDrop.focus();
  }
  function wizardFields(): Record<string, string | boolean> {
    const d = details() as unknown as Record<string, unknown>;
    const f: Record<string, string | boolean> = { 'cw-guide-ok': true, 'cw-title': fields.title, 'cw-desc': fields.description, 'cw-asset': fields.work, 'cw-price': fields.price, 'cw-address': fields.address };
    if (type === 'game') f['cw-entry'] = String(d.entry ?? '');
    if (type === 'music') { f['cw-preview-file'] = String(d.previewFile ?? ''); f['cw-preview-start'] = fields.previewStart; f['cw-preview-end'] = fields.previewEnd; }
    if (type === 'book') { f['cw-book-file'] = String(d.bookFile ?? ''); f['cw-book-preview'] = String(d.previewFile ?? ''); f['cw-book-pages'] = fields.bookPreviewPages; f['cw-book-total'] = fields.bookPages; }
    if (type === 'ticket') Object.assign(f, { 'cw-t-event': fields.tEvent, 'cw-t-start': fields.tStart, 'cw-t-end': fields.tEnd, 'cw-t-venue': fields.tVenue, 'cw-t-qty': fields.tQty, 'cw-t-refund': fields.tRefund, 'cw-t-contact': fields.tContact });
    if (type === 'digital') f['cw-d-label'] = fields.dLabel;
    return f;
  }
  function showDrop() { deps.root.dataset.mode = 'drop'; title.focus(); }
  detailBtn.onclick = showWizard;
  toDrop.onclick = showDrop;
  backBtn.onclick = () => { saveDraft(); deps.back(); };

  /* ── 시작: 초안이 있으면 한 줄로 묻는다 ── */
  const draft = readDraft();
  if (draft && (draft.fileShas.length || draft.published)) {
    resume.hidden = false;
    resume.append(h('span', {}, say('resumeSay', { title: draft.fields.title || draft.published?.manifest.title || '' })));
    if (!draft.published) resume.append(h('span', { class: 'dp-hint' }, sayRaw(' 같은 파일을 다시 놓으면 칸을 이어서 채우고, 이미 올린 파일은 건너뛰어요.')));
    const go = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-resume-go' }, say('resumeGo'));
    const del = h('button', { type: 'button', class: 'ghost dp-btn', id: 'dp-resume-drop' }, say('resumeDrop'));
    go.onclick = async () => {
      resume.hidden = true;
      if (draft.published) {
        type = draft.type; format = draft.format; fields = { ...EMPTY_FIELDS, ...draft.fields }; look = draft.look; genre = draft.genre ?? { main: null, tags: [] }; tracks = draft.tracks; cache = new Map(draft.cache);
        published = draft.published; guess = null; content = []; cover = null; touched = { work: true, price: true, preview: true };
        fire('resume'); await refreshChain();
      } else filesIn.click();
    };
    del.onclick = () => { resume.hidden = true; dropDraft(); };
    resume.append(go, del);
  }
  shell.dataset.state = state;
  paint();

  return {
    dropPaths, dropFiles, pasteCid, showWizard, showDrop, reset,
    /** main.ts 의 창 드롭 안내(dropVeil)가 쓸 문구. */
    overlayCopy: () => ({ title: say('overlay'), why: say('overlaySay'), ok: acceptsDrop(state) }),
    get state() { return state; },
    get mode() { return deps.root.dataset.mode; },
  };
}
