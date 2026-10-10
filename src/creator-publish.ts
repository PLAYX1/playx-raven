import { atomsToRvn, rvnToAtoms } from '../core/creator/bytes';
import { CREATOR_ASSET_PREFIX, checkCreatorAssetName, suggestCreatorAssetName } from '../core/creator/asset-name';
import { SCRIPT_NOTICE, extOf, type ContentType, type FileInput } from '../core/creator/limits';
import { buildListingRequest } from '../core/creator/listing';
import { CreatorError } from '../core/creator/manifest';
import { REAL_MAINNET_ISSUE_ENABLED, planIssue, precheck, publishContent, type IssuePlan, type Issuer, type MessageSigner, type PinAdapter, type PublishInput, type PublishResult } from '../core/creator/publish';
import { DRAFT_PLATFORM_FEE_BPS, splitPrice } from '../core/game-registry/platform-fee';

/*
 * 데스크탑 「내 게임·음악 올리기」(판매자 기능을 켠 사람에게만). 규칙·검사는 전부 core/creator(지갑 저장소에서 복사)에 있고
 * 여기는 고르고·보여 주고·누르는 것만 한다.
 *
 * 바깥 세계와 닿는 곳은 셋뿐이고 전부 기존 명령이다:
 *   · 보관(pin): ipfs_add_file — 앱 안 IPFS(kubo)에 cid-version=0·pin=true 로 올린다(가게 사진과 같은 길).
 *   · 서명: sign_message — 노드 signmessage. 개인키는 화면에 오지 않는다. 지갑이 잠겨 있으면 비밀번호를 한 번 묻고 바로 지운다.
 *   · 발행: issue_asset — **시험망(test·regtest)에서만** 부른다. 메인넷 발행은 REAL_MAINNET_ISSUE_ENABLED(대표 결정)가 켜야 열린다.
 * 시드·비밀번호·서명 문구를 로그로 남기지 않는다.
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

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
function list(target: HTMLElement, items: string[], cls = '') {
  target.replaceChildren(...items.map(text => { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; return li; }));
}
const errText = (e: unknown) => e instanceof CreatorError ? (e.detail || e.code) : String((e as Error)?.message ?? e);

async function readFiles(fileList: FileList | null, role: 'content' | 'cover', fromFolder: boolean): Promise<FileInput[]> {
  const out: FileInput[] = [];
  for (const f of Array.from(fileList ?? [])) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    // 폴더로 고르면 「폴더이름/…」로 온다. 맨 앞 폴더 이름은 묶음 안 경로가 아니다.
    const path = fromFolder && rel.includes('/') ? rel.split('/').slice(1).join('/') : f.name;
    out.push({ path, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, role });
  }
  return out;
}

export type CreatorDeps = {
  invoke: Invoke; askPassword: () => Promise<string | null>; back: () => void;
  /** 시험이 모의 보관소·발행기를 넣을 수 있다. 화면 기본은 kubo·노드. */
  pin?: PinAdapter; issuer?: Issuer; now?: () => Date;
};

export function wireCreatorPublish(deps: CreatorDeps) {
  const pin = deps.pin ?? kuboPinAdapter(deps.invoke);
  const issuer = deps.issuer ?? nodeIssuer(deps.invoke);
  const sign = nodeSigner(deps.invoke, deps.askPassword);
  let content: FileInput[] = [], cover: FileInput[] = [], published: PublishResult | null = null, plan: IssuePlan | null = null, busy = false;
  let chain = 'unknown', owned: string[] = [], taken: boolean | null = null;

  const type = (): ContentType => (document.querySelector<HTMLInputElement>('input[name="creator-type"]:checked')?.value === 'music' ? 'music' : 'game');
  const assetName = () => CREATOR_ASSET_PREFIX + input('creator-asset').value.trim().toUpperCase();
  el('creator-prefix').textContent = CREATOR_ASSET_PREFIX;
  el('creator-pin-holder').textContent = pin.holder;

  function feeLine() {
    const raw = input('creator-price').value.trim();
    const atoms = raw ? rvnToAtoms(raw) : null;
    const out = el('creator-fee');
    if (!raw) { out.textContent = '가격을 비우면 무료로 올려요(판매 없음).'; return; }
    if (!atoms) { out.textContent = 'RVN 금액은 숫자로, 소수점 아래 8자리까지 적어 주세요.'; return; }
    try {
      const s = splitPrice(atoms, DRAFT_PLATFORM_FEE_BPS);
      out.textContent = `구매자가 ${atomsToRvn(atoms)} RVN 을 내면 ${atomsToRvn(s.sellerAtoms)} RVN 은 내 받는 주소로, ${atomsToRvn(s.feeAtoms)} RVN 은 플랫폼 수수료로 가요. 수수료율 ${DRAFT_PLATFORM_FEE_BPS / 100}% 는 초안이에요(대표 결정 대기). 결제는 검증된 뒤에만 열려요.`;
    } catch { out.textContent = '가격이 너무 작아 수수료를 떼고 나면 받을 돈이 남지 않아요.'; }
  }
  function nameLine() {
    const c = checkCreatorAssetName(assetName());
    el('creator-name-say').textContent = c.valid ? `자산 이름: ${c.name} (${c.name.length}/30자)` : c.problems.join(' ');
  }
  function kindFields() {
    const t = type();
    el('creator-game-fields').hidden = t !== 'game';
    el('creator-music-fields').hidden = t !== 'music';
    el('creator-folder-wrap').hidden = t !== 'game';
    input('creator-files').accept = t === 'game' ? '.html,.htm,.js,.mjs,.css,.json,.txt,.svg,.png,.jpg,.jpeg,.webp,.gif,.mp3,.m4a,.ogg,.wav,.woff,.woff2,.wasm,.glb' : '.mp3,.m4a,.ogg,.opus,.wav,.flac';
    reset();
  }
  function fillSelect(id: string, paths: string[]) {
    const sel = el<HTMLSelectElement>(id), keep = sel.value;
    sel.replaceChildren(...paths.map(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; return o; }));
    if (paths.includes(keep)) sel.value = keep;
    else if (paths.includes('index.html')) sel.value = 'index.html';
  }
  function reset() {
    published = null; plan = null;
    el('creator-result').hidden = true; el('creator-confirm').hidden = true; el('creator-done').hidden = true;
    (el('creator-upload') as HTMLButtonElement).disabled = true;
    el('creator-check').replaceChildren(); el('creator-upload-say').textContent = '';
  }
  function gatherInput(): PublishInput {
    const t = type();
    const price = input('creator-price').value.trim();
    const sec = (id: string) => Math.round(Number(input(id).value) * 1000);
    return {
      type: t, asset: assetName(), title: input('creator-title').value, description: el<HTMLTextAreaElement>('creator-desc').value,
      files: [...content, ...cover], creatorAddress: input('creator-address').value.trim(),
      receivingAddress: (input('creator-receiving').value.trim() || input('creator-address').value.trim()),
      priceAtoms: price ? (rvnToAtoms(price) ?? 'invalid') : null, declaredFeeBps: DRAFT_PLATFORM_FEE_BPS,
      game: t === 'game' ? { entry: el<HTMLSelectElement>('creator-entry').value, origin: input('creator-origin').value.trim() || null,
        identity: input('creator-cap-identity').checked, payment: input('creator-cap-payment').checked } : undefined,
      music: t === 'music' ? { previewFile: el<HTMLSelectElement>('creator-preview-file').value, previewStartMs: sec('creator-preview-start'), previewEndMs: sec('creator-preview-end') } : undefined,
      now: deps.now?.() ?? new Date(),
    };
  }
  function runCheck(): boolean {
    const inp = gatherInput();
    const { check, problems } = precheck(inp);
    if (inp.priceAtoms === 'invalid') problems.push('가격은 RVN 숫자로 적어 주세요(소수점 아래 8자리까지).');
    if (inp.type === 'music') {
      const m = inp.music!;
      if (!(m.previewEndMs > m.previewStartMs + 999 && m.previewEndMs - m.previewStartMs <= 60_000)) problems.push('미리듣기 구간은 1초 이상 60초 이하로 정해 주세요.');
    }
    const box = el('creator-check');
    const head = document.createElement('p');
    const size = check.totalBytes < 1024 * 1024 ? `${Math.max(1, Math.round(check.totalBytes / 1024))}KB` : `${(check.totalBytes / 1024 / 1024).toFixed(1)}MB`;
    head.textContent = problems.length ? `고칠 곳 ${problems.length}개` : `올릴 수 있어요 · 파일 ${check.files.length}개 · ${size}`;
    head.className = problems.length ? 'creator-bad' : 'creator-good';
    const bad = document.createElement('ul'); list(bad, problems);
    const warn = document.createElement('ul'); list(warn, check.warnings.map(w => '주의 · ' + (w.path ? `${w.path}: ` : '') + w.say), 'creator-warn');
    const note = document.createElement('p'); note.className = 'meta'; note.textContent = SCRIPT_NOTICE;
    // 게임은 「코드를 실행해요」 경고가 같은 안내를 이미 담고 있다 — 두 번 쓰지 않는다.
    const noted = check.warnings.some(w => w.say.includes(SCRIPT_NOTICE));
    box.replaceChildren(head, ...(problems.length ? [bad] : []), ...(check.warnings.length ? [warn] : []), ...(noted ? [] : [note]));
    (el('creator-upload') as HTMLButtonElement).disabled = problems.length > 0 || busy;
    return problems.length === 0;
  }

  async function onFiles(id: string, role: 'content' | 'cover', folder: boolean) {
    const files = await readFiles(input(id).files, role, folder);
    if (role === 'cover') cover = files.slice(0, 1); else content = files;
    const paths = content.map(f => f.path);
    fillSelect('creator-entry', paths.filter(p => ['html', 'htm'].includes(extOf(p))));
    fillSelect('creator-preview-file', paths);
    reset();
    el('creator-files-say').textContent = `${content.length}개 파일${cover.length ? ' · 표지 1장' : ''}`;
  }

  async function upload() {
    if (busy || !runCheck()) return;
    busy = true; (el('creator-upload') as HTMLButtonElement).disabled = true;
    el('creator-upload-say').textContent = pin.real ? '올리는 중… 파일이 많으면 오래 걸려요.' : '시험 보관소에 올리는 중…';
    try {
      published = await publishContent(gatherInput(), pin, sign);
      el('creator-cid').textContent = published.manifestCid;
      el('creator-sha').textContent = published.manifestSha256;
      el('creator-pinned-by').textContent = published.pinnedBy;
      el('creator-result').hidden = false;
      el('creator-upload-say').textContent = '올렸어요. 아직 아무에게도 보이지 않아요 — 자산을 발행해야 목록에 나타나요.';
      await prepareConfirm();
    } catch (e) {
      el('creator-upload-say').textContent = `올리지 못했어요: ${errText(e)}. 일부 파일은 보관함에 남아 있을 수 있어요.`;
    } finally { busy = false; (el('creator-upload') as HTMLButtonElement).disabled = !!published; }
  }

  async function prepareConfirm() {
    if (!published) return;
    const asset = published.manifest.asset;
    const [node, tokens, isTaken] = await Promise.allSettled([
      deps.invoke<{ chain?: string }>('node_status'), deps.invoke<string[]>('owner_tokens'), deps.invoke<boolean>('name_taken', { name: asset })]);
    chain = node.status === 'fulfilled' ? String(node.value?.chain ?? 'unknown') : 'unknown';
    owned = tokens.status === 'fulfilled' && Array.isArray(tokens.value) ? tokens.value.map(String) : [];
    taken = isTaken.status === 'fulfilled' ? isTaken.value === true : null;
    el('creator-c-name').textContent = asset;
    el('creator-c-cid').textContent = published.manifestCid;
    el('creator-c-chain').textContent = chain === 'main' ? '메인넷(실제 돈)' : ['test', 'regtest'].includes(chain) ? `시험망(${chain})` : `알 수 없음(${chain})`;
    input('creator-typed').value = '';
    el('creator-confirm').hidden = false;
    paintPlan();
  }
  function paintPlan() {
    if (!published) return;
    plan = planIssue({ asset: published.manifest.asset, manifestCid: published.manifestCid, chain, ownedAssets: owned, nameTaken: taken,
      chainBurnRvn: null, typedName: input('creator-typed').value.trim(), realMainnetEnabled: REAL_MAINNET_ISSUE_ENABLED });
    el('creator-c-burn').textContent = `${plan.burn.rvn} RVN (${plan.params.name.includes('/') ? '하위 자산' : '루트 자산'})`;
    el('creator-c-burn-check').textContent = plan.burn.status === 'unverifiable' ? '체인과 대조: 확인 불가 — 저장소에 적힌 값이에요. 노드에 묻는 방법이 없어 실제 소각액과 대조하지 못했어요.' : plan.burn.say;
    list(el('creator-c-irreversible'), plan.irreversible);
    list(el('creator-c-blockers'), plan.blockers.filter(b => !b.includes('다시 적어')), 'creator-bad');
    (el('creator-issue') as HTMLButtonElement).disabled = !plan.canIssue || busy;
  }

  async function issue() {
    if (!published || !plan?.canIssue || busy) return;
    busy = true; (el('creator-issue') as HTMLButtonElement).disabled = true;
    el('creator-issue-say').textContent = '발행하는 중…';
    try {
      const { txid } = await issuer.issue(plan.params);
      const req = buildListingRequest({ manifest: published.manifest, manifestCid: published.manifestCid, manifestSha256: published.manifestSha256, issueTxid: txid, now: deps.now?.() ?? new Date() });
      el('creator-txid').textContent = txid;
      el<HTMLTextAreaElement>('creator-request').value = JSON.stringify(req, null, 2);
      el('creator-done').hidden = false; el('creator-confirm').hidden = true;
      el('creator-issue-say').textContent = '';
    } catch (e) {
      el('creator-issue-say').textContent = `발행하지 못했어요: ${errText(e)}`;
    } finally { busy = false; if (!el('creator-confirm').hidden) paintPlan(); }
  }

  document.querySelectorAll<HTMLInputElement>('input[name="creator-type"]').forEach(r => { r.onchange = kindFields; });
  input('creator-files').onchange = () => void onFiles('creator-files', 'content', false);
  input('creator-folder').onchange = () => void onFiles('creator-folder', 'content', true);
  input('creator-cover').onchange = () => void onFiles('creator-cover', 'cover', false);
  input('creator-price').oninput = () => { feeLine(); reset(); };
  input('creator-asset').oninput = () => { nameLine(); reset(); };
  input('creator-title').oninput = () => {
    if (!input('creator-asset').dataset.touched) { input('creator-asset').value = suggestCreatorAssetName(input('creator-title').value).slice(CREATOR_ASSET_PREFIX.length); nameLine(); }
    reset();
  };
  input('creator-asset').addEventListener('keydown', () => { input('creator-asset').dataset.touched = '1'; });
  ['creator-address', 'creator-receiving', 'creator-origin', 'creator-preview-start', 'creator-preview-end', 'creator-cap-identity', 'creator-cap-payment']
    .forEach(id => input(id).addEventListener('input', reset));
  el('creator-desc').addEventListener('input', reset);
  el('creator-check-run').onclick = () => { runCheck(); };
  el('creator-upload').onclick = () => void upload();
  input('creator-typed').oninput = paintPlan;
  el('creator-issue').onclick = () => void issue();
  el('creator-new-address').onclick = async () => {
    try { input('creator-address').value = String(await deps.invoke<string>('new_address', { label: 'creator' })); reset(); }
    catch (e) { el('creator-files-say').textContent = `주소를 받지 못했어요: ${errText(e)}`; }
  };
  el('creator-copy-request').onclick = () => { void navigator.clipboard?.writeText(el<HTMLTextAreaElement>('creator-request').value).catch(() => undefined); };
  el('creator-back').onclick = deps.back;
  kindFields(); feeLine(); nameLine();
  return { reset };
}
