// 지갑 파일 내보내기·가져오기 + 백업 열쇠(52글자) 종이 단계 — 설정 화면의 「백업」 칸 안에 스스로 붙는다. (0.8.7)
//
// 🔴 이 화면은 흐름만 안내한다. 지켜야 할 것은 Rust(`walletfile.rs`)가 지킨다:
//    평문 내보내기 없음 · 지갑 암호 없으면 거절 · 지갑 암호 재인증 · 잠긴 동안 IPC 거부 · 쓴 뒤 다시 읽어 확인 ·
//    가져오기는 현재 지갑을 먼저 따로 보관(`recover::restore_apply`).
// 🔴 열쇠·암호는 변수에 오래 두지 않고 `textContent`/`value` 로만 다룬다(innerHTML 에 넣지 않는다). 쓰고 나면 비운다.
// 🔴 폴더·파일 위치는 사용자가 선택창에서 직접 고른다(플러그인 dialog `open`).
import { invoke } from "@tauri-apps/api/core";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { lang, coreLang } from "./i18n";

type Lang = "ko" | "en" | "ja" | "zh";
export const NEEDS_WALLET_PASS = "NEEDS_WALLET_PASS:";
const PAPER_FLAG = "rv-key-paper-done";

type Copy = {
  paperLead: string; paperLeadPass: string; step1: string; step2: string; step3: string;
  showKey: string; hideKey: string; keyHidden: string; keyAuto: string; copyKey: string; copied: string; copyFail: string;
  printKey: string; printOpened: string; walletPassFor: string; paperDone: string; paperDoneMark: string; paperPending: string;
  title: string; lede: string; exportBtn: string; importBtn: string;
  blockedTitle: string; blockedBody: string; goWallet: string; close: string; nodeDown: string;
  pickFolder: string; folderNone: string; folderPicked: string; exportExplain: string; walletPass: string; doExport: string; working: string;
  wrote: string; verified: string; fileAt: string; endTitle: string; endNeed: string; endAsk: string; finish: string; finished: string; seeKeyAgain: string;
  pickFile: string; fileNone: string; modeKey: string; modePass: string; secretKey: string; secretPass: string; openIt: string;
  opened: string; fingerprint: string; same: string; currentKept: string; importWarn: string; confirmSwitch: string; doSwitch: string; cancel: string;
  switched: string; keptAt: string; restartApp: string; switchFailed: string; canceled: string; empty: string;
  refusedStandby: string;
};

const KO: Copy = {
  paperLead: "컴퓨터가 죽으면, 이 52글자가 없으면 못 엽니다.",
  paperLeadPass: "백업 암호를 정해 두셨어도, 암호를 잊었을 때의 마지막 열쇠는 이 52글자예요. 컴퓨터가 죽으면 이 열쇠도 같이 사라져요.",
  step1: "① 열쇠 보기", step2: "② 종이에 적거나 인쇄", step3: "③ 12단어와 같이 보관",
  showKey: "열쇠 보기", hideKey: "다시 감추기", keyHidden: "눌러서 보기", keyAuto: "90초 뒤 저절로 가려져요.",
  copyKey: "복사", copied: "복사했어요(30초 뒤 지움)", copyFail: "복사가 안 돼요",
  printKey: "인쇄용 파일 열기", printOpened: "브라우저에서 열었어요. ⌘P(윈도우는 Ctrl+P)로 인쇄하세요. 이 파일은 10분 뒤 프로그램이 지워요.",
  walletPassFor: "지갑 암호 (인쇄용 파일을 만들기 위한 확인)",
  paperDone: "종이에 적어서 12단어와 같이 보관했어요", paperDoneMark: "✔ 종이 보관을 확인했어요", paperPending: "아직 종이에 적었다고 확인하지 않았어요.",
  title: "지갑 파일 내보내기 · 가져오기",
  lede: "지갑 사본을 iCloud 폴더·USB 같은 곳에 파일 하나로 두거나, 그런 파일에서 지갑을 되살려요. 내보낸 파일은 항상 백업 열쇠(52글자)로 한 번 더 잠겨요 — 잠그지 않은 파일은 만들지 않아요.",
  exportBtn: "지갑 파일 내보내기…", importBtn: "지갑 파일 가져오기…",
  blockedTitle: "먼저 지갑 암호를 걸어 주세요",
  blockedBody: "지갑 암호가 아직 없어요. 암호가 없으면 잠가도 누구나 바로 풀 수 있고, 파일로 꺼낸 지갑은 그 파일을 주운 사람이 돈을 쓸 수 있어요. 지갑 화면에서 10글자 이상 암호를 정한 뒤 다시 해 주세요.",
  goWallet: "지갑 화면으로", close: "닫기", nodeDown: "노드가 응답하지 않아 지갑 암호가 있는지 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.",
  pickFolder: "저장할 폴더 고르기…", folderNone: "아직 고르지 않았어요", folderPicked: "저장할 폴더",
  exportExplain: "iCloud Drive 폴더나 USB 같은 곳을 직접 고르세요. 파일 이름은 RavenVault-wallet-날짜.rvwallet 이에요. 만든 뒤 다시 읽어 열어 보고 원본과 같은지 확인해요.",
  walletPass: "지갑 암호 (본인 확인)", doExport: "내보내기", working: "만드는 중… (다시 읽어 확인까지 해요)",
  wrote: "파일을 만들었어요.", verified: "쓴 뒤 다시 읽어 열쇠로 풀어 보았고, 원본과 같았어요.", fileAt: "파일 위치",
  endTitle: "마지막 확인", endNeed: "이 파일은 백업 열쇠 52글자(또는 백업 암호) 없이는 못 열려요. 컴퓨터가 죽으면 열쇠도 같이 사라져요.",
  endAsk: "백업 열쇠 52글자를 종이에 적어 12단어와 같이 보관했어요", finish: "끝내기", finished: "완료했어요. 파일은 안전한 곳(예: 집이 아닌 다른 장소의 USB)에도 한 부 두세요.", seeKeyAgain: "열쇠 다시 보기",
  pickFile: "가져올 파일 고르기…", fileNone: "아직 고르지 않았어요", modeKey: "종이의 52글자 열쇠로 열기", modePass: "백업 암호로 열기",
  secretKey: "52글자 열쇠", secretPass: "백업 암호", openIt: "열어 보기",
  opened: "열었어요. 아직 현재 지갑은 그대로예요.", fingerprint: "지문(앞 8자리)", same: "지금 쓰는 지갑과 같은 파일이에요. 바꿀 필요가 없어요.",
  currentKept: "전환하면 지금 지갑은 먼저 따로 보관한 뒤에 바뀌어요(지우지 않아요).",
  importWarn: "전환하려면 레이븐 노드를 완전히 종료해야 해요(켜져 있으면 거절돼요). 같은 지갑을 두 컴퓨터에서 동시에 쓰지 마세요.",
  confirmSwitch: "노드를 껐고, 지금 지갑이 따로 보관된 뒤 이 지갑으로 바뀐다는 것을 이해했어요", doSwitch: "이 지갑으로 전환", cancel: "그만두기",
  switched: "전환했어요.", keptAt: "이전 지갑 보관 위치", restartApp: "앱을 다시 켜고 노드를 시작하면 적용돼요.", switchFailed: "전환하지 못했어요. 지금 지갑은 그대로예요.", canceled: "그만뒀어요. 지금 지갑은 그대로예요.",
  empty: "값을 넣어 주세요.",
  refusedStandby: "지갑 암호가 아직 없어서 켜지 않았어요. 암호가 없으면 잠가도 누구나 풀 수 있어요.",
};
const EN: Copy = {
  paperLead: "If this computer dies, you cannot open the backup without these 52 characters.",
  paperLeadPass: "Even if you set a backup password, these 52 characters are the last key if you forget it. When the computer dies, this key dies with it.",
  step1: "1. Show the key", step2: "2. Write it down or print it", step3: "3. Keep it with your 12 words",
  showKey: "Show key", hideKey: "Hide again", keyHidden: "Tap to show", keyAuto: "It hides itself after 90 seconds.",
  copyKey: "Copy", copied: "Copied (cleared in 30 seconds)", copyFail: "Copy failed",
  printKey: "Open printable file", printOpened: "Opened in your browser. Press ⌘P (Ctrl+P on Windows) to print. The app deletes this file in 10 minutes.",
  walletPassFor: "Wallet password (to confirm it is you before making the printable file)",
  paperDone: "I wrote it on paper and keep it with my 12 words", paperDoneMark: "✔ Paper copy confirmed", paperPending: "You haven't confirmed a paper copy yet.",
  title: "Export / import wallet file",
  lede: "Put a wallet copy in one file in an iCloud folder, USB drive, etc., or restore a wallet from such a file. Exported files are always locked once more with the backup key (52 characters) — an unlocked file is never made.",
  exportBtn: "Export wallet file…", importBtn: "Import wallet file…",
  blockedTitle: "Set a wallet password first",
  blockedBody: "This wallet has no password yet. Without one, a lock can be opened by anyone, and anyone who finds an exported file can spend the money. Set a password of 10+ characters on the Wallet screen, then try again.",
  goWallet: "Go to Wallet", close: "Close", nodeDown: "The node isn't responding, so we can't check whether the wallet has a password. Start the node and try again.",
  pickFolder: "Choose a folder…", folderNone: "Not chosen yet", folderPicked: "Save to",
  exportExplain: "Pick an iCloud Drive folder, a USB drive, etc. yourself. The file is named RavenVault-wallet-DATE.rvwallet. After writing, we read it back, open it and compare with the original.",
  walletPass: "Wallet password (to confirm it is you)", doExport: "Export", working: "Working… (includes reading back to verify)",
  wrote: "The file was created.", verified: "After writing, we read it back, unlocked it with the key and it matched the original.", fileAt: "File location",
  endTitle: "Last check", endNeed: "This file cannot be opened without the 52-character backup key (or the backup password). When the computer dies, the key dies with it.",
  endAsk: "I wrote the 52-character backup key on paper and keep it with my 12 words", finish: "Finish", finished: "Done. Also keep one copy of the file somewhere safe (e.g. a USB drive kept elsewhere).", seeKeyAgain: "Show key again",
  pickFile: "Choose a file to import…", fileNone: "Not chosen yet", modeKey: "Open with the 52-character key from paper", modePass: "Open with the backup password",
  secretKey: "52-character key", secretPass: "Backup password", openIt: "Open it",
  opened: "Opened. Your current wallet is still untouched.", fingerprint: "Fingerprint (first 8)", same: "This is the same file as the wallet you use now. No need to switch.",
  currentKept: "When you switch, your current wallet is set aside first (not deleted).",
  importWarn: "To switch, the Raven node must be fully stopped (it is refused while running). Never use the same wallet on two computers at once.",
  confirmSwitch: "I stopped the node and understand my current wallet is set aside before switching to this one", doSwitch: "Switch to this wallet", cancel: "Cancel",
  switched: "Switched.", keptAt: "Previous wallet kept at", restartApp: "Restart the app and start the node to apply it.", switchFailed: "Could not switch. Your current wallet is unchanged.", canceled: "Canceled. Your current wallet is unchanged.",
  empty: "Please enter a value.",
  refusedStandby: "Not turned on: the wallet has no password yet. Without one, anyone can unlock it.",
};
const JA: Copy = {
  paperLead: "このコンピュータが壊れると、この52文字がなければバックアップを開けません。",
  paperLeadPass: "バックアップパスワードを設定していても、忘れたときの最後の鍵はこの52文字です。コンピュータが壊れるとこの鍵も一緒に消えます。",
  step1: "① 鍵を表示", step2: "② 紙に書く・印刷", step3: "③ 12ワードと一緒に保管",
  showKey: "鍵を表示", hideKey: "隠す", keyHidden: "タップして表示", keyAuto: "90秒後に自動で隠れます。",
  copyKey: "コピー", copied: "コピーしました（30秒後に消去）", copyFail: "コピーできません",
  printKey: "印刷用ファイルを開く", printOpened: "ブラウザで開きました。⌘P（WindowsはCtrl+P）で印刷してください。このファイルは10分後にアプリが削除します。",
  walletPassFor: "ウォレットのパスワード（印刷用ファイルを作る前の本人確認）",
  paperDone: "紙に書いて12ワードと一緒に保管しました", paperDoneMark: "✔ 紙での保管を確認しました", paperPending: "紙に書いたことをまだ確認していません。",
  title: "ウォレットファイルの書き出し・読み込み",
  lede: "ウォレットのコピーをiCloudフォルダやUSBなどに1つのファイルとして置いたり、そのファイルからウォレットを復元したりします。書き出したファイルは必ずバックアップ鍵（52文字）でもう一度ロックされます。ロックしていないファイルは作りません。",
  exportBtn: "ウォレットファイルを書き出す…", importBtn: "ウォレットファイルを読み込む…",
  blockedTitle: "先にウォレットのパスワードを設定してください",
  blockedBody: "ウォレットにまだパスワードがありません。パスワードがないと、ロックしても誰でも解除でき、書き出したファイルを拾った人がお金を使えます。ウォレット画面で10文字以上のパスワードを設定してから、もう一度お試しください。",
  goWallet: "ウォレット画面へ", close: "閉じる", nodeDown: "ノードが応答しないため、パスワードの有無を確認できません。ノードを起動してからもう一度お試しください。",
  pickFolder: "保存先フォルダを選ぶ…", folderNone: "まだ選んでいません", folderPicked: "保存先",
  exportExplain: "iCloud DriveのフォルダやUSBなどを自分で選んでください。ファイル名は RavenVault-wallet-日付.rvwallet です。作成後に読み直して開き、元と同じか確認します。",
  walletPass: "ウォレットのパスワード（本人確認）", doExport: "書き出す", working: "作成中…（読み直して確認するまで行います）",
  wrote: "ファイルを作成しました。", verified: "書き込み後に読み直し、鍵で開いて元と同じことを確認しました。", fileAt: "ファイルの場所",
  endTitle: "最後の確認", endNeed: "このファイルは、バックアップ鍵（52文字）またはバックアップパスワードがないと開けません。コンピュータが壊れると鍵も一緒に消えます。",
  endAsk: "バックアップ鍵の52文字を紙に書いて12ワードと一緒に保管しました", finish: "完了", finished: "完了しました。ファイルは安全な別の場所（例：別の場所に置いたUSB）にも1部置いてください。", seeKeyAgain: "鍵をもう一度表示",
  pickFile: "読み込むファイルを選ぶ…", fileNone: "まだ選んでいません", modeKey: "紙の52文字の鍵で開く", modePass: "バックアップパスワードで開く",
  secretKey: "52文字の鍵", secretPass: "バックアップパスワード", openIt: "開いてみる",
  opened: "開きました。現在のウォレットはまだそのままです。", fingerprint: "指紋（先頭8桁）", same: "現在使っているウォレットと同じファイルです。切り替える必要はありません。",
  currentKept: "切り替えると、現在のウォレットを先に別に保管してから入れ替えます（削除しません）。",
  importWarn: "切り替えにはRavenノードを完全に停止する必要があります（起動中は拒否されます）。同じウォレットを2台で同時に使わないでください。",
  confirmSwitch: "ノードを停止し、現在のウォレットが別に保管されてからこのウォレットに切り替わることを理解しました", doSwitch: "このウォレットに切り替える", cancel: "やめる",
  switched: "切り替えました。", keptAt: "以前のウォレットの保管場所", restartApp: "アプリを再起動してノードを開始すると反映されます。", switchFailed: "切り替えできませんでした。現在のウォレットはそのままです。", canceled: "やめました。現在のウォレットはそのままです。",
  empty: "値を入力してください。",
  refusedStandby: "ウォレットにパスワードがないため、オンにしませんでした。パスワードがないと誰でも解除できます。",
};
const ZH: Copy = {
  paperLead: "电脑损坏后，没有这52个字符就无法打开备份。",
  paperLeadPass: "即使设置了备份密码，忘记密码时的最后一把钥匙就是这52个字符。电脑损坏时，这把钥匙也会一起消失。",
  step1: "① 查看密钥", step2: "② 写在纸上或打印", step3: "③ 与12个恢复词一起保管",
  showKey: "查看密钥", hideKey: "重新隐藏", keyHidden: "点击查看", keyAuto: "90秒后自动隐藏。",
  copyKey: "复制", copied: "已复制（30秒后清除）", copyFail: "无法复制",
  printKey: "打开打印文件", printOpened: "已在浏览器中打开。按 ⌘P（Windows 为 Ctrl+P）打印。应用会在10分钟后删除此文件。",
  walletPassFor: "钱包密码（生成打印文件前的身份确认）",
  paperDone: "我已写在纸上，并与12个恢复词一起保管", paperDoneMark: "✔ 已确认纸质保管", paperPending: "尚未确认已写在纸上。",
  title: "导出 / 导入钱包文件",
  lede: "把钱包副本作为单个文件放到 iCloud 文件夹、U 盘等位置，或从这样的文件恢复钱包。导出的文件始终会再用备份密钥（52个字符）锁一次——不会生成未加锁的文件。",
  exportBtn: "导出钱包文件…", importBtn: "导入钱包文件…",
  blockedTitle: "请先设置钱包密码",
  blockedBody: "此钱包还没有密码。没有密码时，加锁后任何人都能直接解锁，捡到导出文件的人也能花掉钱。请在钱包页面设置10个字符以上的密码，然后重试。",
  goWallet: "前往钱包页面", close: "关闭", nodeDown: "节点没有响应，无法确认钱包是否有密码。请启动节点后重试。",
  pickFolder: "选择保存文件夹…", folderNone: "尚未选择", folderPicked: "保存到",
  exportExplain: "请自行选择 iCloud Drive 文件夹或 U 盘等位置。文件名为 RavenVault-wallet-日期.rvwallet。写入后会重新读取、打开并与原件比对。",
  walletPass: "钱包密码（身份确认）", doExport: "导出", working: "正在生成…（包括重新读取验证）",
  wrote: "文件已生成。", verified: "写入后已重新读取，用密钥解开，并确认与原件一致。", fileAt: "文件位置",
  endTitle: "最后确认", endNeed: "没有52个字符的备份密钥（或备份密码）就无法打开此文件。电脑损坏时，密钥也会一起消失。",
  endAsk: "我已把52个字符的备份密钥写在纸上，并与12个恢复词一起保管", finish: "完成", finished: "已完成。请再在安全的地方（例如放在别处的 U 盘）保留一份文件。", seeKeyAgain: "再次查看密钥",
  pickFile: "选择要导入的文件…", fileNone: "尚未选择", modeKey: "用纸上的52个字符密钥打开", modePass: "用备份密码打开",
  secretKey: "52个字符的密钥", secretPass: "备份密码", openIt: "打开查看",
  opened: "已打开。当前钱包仍保持原样。", fingerprint: "指纹（前8位）", same: "这与您正在使用的钱包是同一个文件，无需切换。",
  currentKept: "切换时，会先把当前钱包另行保管，再进行替换（不会删除）。",
  importWarn: "切换前必须完全停止 Raven 节点（运行中会被拒绝）。请勿在两台电脑上同时使用同一个钱包。",
  confirmSwitch: "我已停止节点，并明白当前钱包会先被另行保管，然后切换为此钱包", doSwitch: "切换到此钱包", cancel: "取消",
  switched: "已切换。", keptAt: "原钱包保管位置", restartApp: "重启应用并启动节点后生效。", switchFailed: "无法切换。当前钱包保持不变。", canceled: "已取消。当前钱包保持不变。",
  empty: "请输入内容。",
  refusedStandby: "未开启：钱包还没有密码。没有密码时任何人都能解锁。",
};
const COPY: Record<Lang, Copy> = { ko: KO, en: EN, ja: JA, zh: ZH };
const c = (): Copy => COPY[coreLang(lang)] ?? KO;
/** 시험·재사용용 — 모르는 말은 영어(i18n 규칙과 같다). */
export const walletFileCopy = (l: string): Copy => COPY[l as Lang] ?? EN;

type Child = Node | string | null | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { className?: string; style?: string } = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(e, rest);
  if (style) e.style.cssText = style; // CSSOM 으로 — 앱 CSP 가 style="" 속성을 막는다
  for (const k of kids) if (k) e.append(k);
  return e;
}
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(NEEDS_WALLET_PASS, "");

function gotoWallet(): void {
  document.querySelector<HTMLElement>('nav a[data-page="wallet"]')?.click();
}

/** 지갑 암호가 없어 막혔다는 안내 상자(내보내기·대기화면·매장용 읽기 전용 공용). */
export function showNeedPass(): void {
  document.getElementById("wf-need-pass")?.remove();
  const t = c();
  const box = el("div", { id: "wf-need-pass", className: "card" },
    el("h3", { textContent: t.blockedTitle }),
    el("p", { className: "meta", textContent: t.blockedBody }),
    el("div", { className: "row" },
      Object.assign(el("button", { textContent: t.goWallet }), { onclick: () => { box.remove(); gotoWallet(); } }),
      Object.assign(el("button", { className: "ghost", textContent: t.close }), { onclick: () => box.remove() })));
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", t.blockedTitle);
  Object.assign(box.style, { position: "fixed", left: "50%", top: "20%", transform: "translateX(-50%)", zIndex: "9999", maxWidth: "min(92vw,520px)", boxShadow: "0 12px 40px rgba(0,0,0,.35)", borderColor: "var(--warn)" });
  document.body.append(box);
  box.querySelector("button")?.focus();
}

/** Rust 가 돌려준 오류가 「지갑 암호 없음」이면 안내 상자를 띄우고 true. */
export function handleLockRefusal(e: unknown): boolean {
  const msg = typeof e === "string" ? e : String((e as Error)?.message ?? "");
  if (!msg.startsWith(NEEDS_WALLET_PASS)) return false;
  showNeedPass();
  return true;
}

const paperDone = (): boolean => { try { return localStorage.getItem(PAPER_FLAG) === "1"; } catch { return false; } };
const setPaperDone = (v: boolean): void => { try { v ? localStorage.setItem(PAPER_FLAG, "1") : localStorage.removeItem(PAPER_FLAG); } catch { /* 저장 안 돼도 흐름은 계속 */ } };

/** 열쇠를 화면에 보여 주는 칸 — 90초 뒤 저절로 가린다. 열쇠는 DOM 글자로만 두고 변수에 남기지 않는다. */
function keyViewer(): { root: HTMLElement; show: () => Promise<void>; hide: () => void; copy: () => Promise<void> } {
  const t = c();
  const box = el("div", { className: "keyshow", textContent: t.keyHidden });
  box.setAttribute("translate", "no");
  let timer: number | undefined;
  const hide = () => { box.textContent = c().keyHidden; box.classList.remove("on"); if (timer) window.clearTimeout(timer); };
  const show = async () => {
    const r = await invoke<{ key?: string }>("cloud_key_show");
    box.textContent = String(r?.key || "");
    box.classList.add("on");
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(hide, 90_000);
  };
  const copy = async () => {
    const text = box.classList.contains("on") ? box.textContent ?? "" : "";
    if (!text) throw new Error("hidden");
    await navigator.clipboard.writeText(text);
    window.setTimeout(() => { void navigator.clipboard.writeText(" ").catch(() => {}); }, 30_000);
  };
  return { root: box, show, hide, copy };
}

/** 종이 단계: 안내 문구 + ①보기 ②적기/인쇄/복사 ③보관 확인. 기존 「이 자물쇠의 열쇠」 칸(#ck-*) 바로 아래에 붙는다. */
async function mountPaperStep(): Promise<void> {
  const ckKey = document.getElementById("ck-key");
  if (!ckKey || document.getElementById("wf-paper")) return;
  const card = ckKey.closest(".card");
  if (!card) return;
  let t = c();
  // 기존 안내 문단은 이 화면이 맡는다(main.ts 는 더 이상 이 문단을 바꾸지 않는다).
  const need = document.getElementById("ck-need");
  const st = await invoke<{ set?: boolean }>("backup_pass_state").catch(() => null);
  const paintNeed = () => {
    if (!need) return;
    need.textContent = "";
    need.append(el("b", { textContent: t.paperLead }));
    if (st?.set) need.append(el("br"), t.paperLeadPass);
  };
  paintNeed();
  // 기존 열쇠 보기/복사 단추는 그대로 두고, 아래에 단계와 확인을 붙인다.
  const viewer = keyViewer();
  const note = el("p", { className: "meta", textContent: "" });
  const status = el("p", { className: "meta", id: "wf-paper-status" });
  const paintStatus = () => { status.textContent = paperDone() ? t.paperDoneMark : t.paperPending; };
  const passIn = el("input", { type: "password", autocomplete: "off", placeholder: t.walletPassFor, id: "wf-print-pass" });
  passIn.style.cssText = "flex:1;min-width:180px";
  const ok = el("input", { type: "checkbox", id: "wf-paper-ok", checked: paperDone() });
  ok.addEventListener("change", () => { setPaperDone(ok.checked); paintStatus(); });
  const steps = el("b", { textContent: `${t.step1}  →  ${t.step2}  →  ${t.step3}` });
  const autoLine = el("p", { className: "meta", textContent: t.keyAuto });
  const showBtn = Object.assign(el("button", { textContent: t.showKey }), { onclick: () => void viewer.show().catch((e) => { note.textContent = errText(e); }) });
  const hideBtn = Object.assign(el("button", { className: "ghost", textContent: t.hideKey }), { onclick: viewer.hide });
  const copyBtn = Object.assign(el("button", { className: "ghost", textContent: t.copyKey }), {
    onclick: () => void viewer.copy().then(() => { note.textContent = t.copied; }).catch(() => { note.textContent = t.copyFail; }),
  });
  const doneText = el("span", { textContent: t.paperDone });
  const wrap = el("div", { id: "wf-paper", className: "card" },
    el("p", { className: "meta" }, steps),
    viewer.root,
    autoLine,
    el("div", { className: "row" }, showBtn, hideBtn, copyBtn),
    el("div", { className: "row", style: "margin-top:8px" }, passIn,
      Object.assign(el("button", { className: "ghost", textContent: t.printKey, id: "wf-print" }), {
        onclick: async () => {
          note.textContent = "";
          try {
            await invoke("key_sheet_print", { lang: coreLang(lang), walletPass: passIn.value });
            note.textContent = t.printOpened;
          } catch (e) { if (!handleLockRefusal(e)) note.textContent = errText(e); }
          finally { passIn.value = ""; }
        },
      })),
    el("label", { className: "meta", style: "display:flex;gap:8px;align-items:flex-start;margin-top:10px" }, ok, doneText),
    status, note);
  paintStatus();
  card.after(wrap);
  // 화면 말을 바꾸면 고정 문구만 새 말로 바꾼다(보이던 열쇠·입력값·확인 표시는 그대로).
  window.addEventListener("desktop-language-change", () => {
    if (!wrap.isConnected) return;
    t = c();
    paintNeed();
    steps.textContent = `${t.step1}  →  ${t.step2}  →  ${t.step3}`;
    autoLine.textContent = t.keyAuto;
    showBtn.textContent = t.showKey; hideBtn.textContent = t.hideKey; copyBtn.textContent = t.copyKey;
    const printBtn = wrap.querySelector<HTMLButtonElement>("#wf-print"); if (printBtn) printBtn.textContent = t.printKey;
    passIn.placeholder = t.walletPassFor;
    doneText.textContent = t.paperDone;
    paintStatus();
  });
}

type Status = { node_up?: boolean; wallet_encrypted?: boolean | null; backup_pass?: boolean };
type Exported = { path?: string; folder?: string; verified?: boolean };
type Prepared = { id?: string; size?: number; fingerprint?: string; same_as_current?: boolean };

async function pickFolder(): Promise<string | null> {
  const r = await pickPath({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

function mountFileCard(): void {
  const anchor = document.getElementById("wf-paper") ?? document.getElementById("ck-key")?.closest(".card");
  if (!anchor || document.getElementById("wf-card")) return;
  let t = c();
  const body = el("div", { id: "wf-body" });
  const exportBtn = el("button", { textContent: t.exportBtn, id: "wf-export" });
  const importBtn = el("button", { className: "ghost", textContent: t.importBtn, id: "wf-import" });
  const head = el("h3", { textContent: t.title, style: "margin-top:0" });
  const lede = el("p", { className: "meta", textContent: t.lede });
  const card = el("div", { id: "wf-card", className: "card", style: "margin-top:12px" },
    head, lede,
    el("div", { className: "row" }, exportBtn, importBtn), body);
  // 화면 말을 바꾸면 제목·안내·두 단추를 새 말로. 진행 중인 단계(body)는 지우지 않고, 다음에 그리는 글부터 새 말이다.
  window.addEventListener("desktop-language-change", () => {
    if (!card.isConnected) return;
    t = c();
    head.textContent = t.title; lede.textContent = t.lede; exportBtn.textContent = t.exportBtn; importBtn.textContent = t.importBtn;
  });

  const reset = () => { body.textContent = ""; };
  const line = (text: string, cls = "meta") => el("p", { className: cls, textContent: text });
  const field = (id: string, ph: string) => {
    const i = el("input", { type: "password", id, placeholder: ph, autocomplete: "off" });
    i.setAttribute("spellcheck", "false");
    i.style.cssText = "flex:1;min-width:200px";
    return i;
  };

  exportBtn.onclick = async () => {
    reset();
    const st = await invoke<Status>("wallet_file_status").catch(() => null);
    if (!st || st.node_up === false) { body.append(line(t.nodeDown, "meta warnbox")); return; }
    if (st.wallet_encrypted === false) { showNeedPass(); body.append(line(t.blockedBody, "meta warnbox")); return; }
    let folder: string | null = null;
    const folderLine = line(`${t.folderPicked}: ${t.folderNone}`);
    const pass = field("wf-ex-pass", t.walletPass);
    const result = el("div");
    const go = el("button", { textContent: t.doExport, id: "wf-ex-go", disabled: true });
    const pick = Object.assign(el("button", { className: "ghost", textContent: t.pickFolder }), {
      onclick: async () => {
        const f = await pickFolder().catch(() => null);
        if (f) { folder = f; folderLine.textContent = `${t.folderPicked}: ${f}`; go.disabled = false; }
      },
    });
    go.onclick = async () => {
      if (!folder || !pass.value) { result.replaceChildren(line(t.empty)); return; }
      go.disabled = true;
      result.replaceChildren(line(t.working));
      try {
        const r = await invoke<Exported>("wallet_export", { dest: folder, walletPass: pass.value });
        pass.value = "";
        showEnd(result, r);
      } catch (e) {
        if (!handleLockRefusal(e)) result.replaceChildren(line(errText(e), "meta warnbox"));
        else result.replaceChildren();
      } finally { pass.value = ""; go.disabled = !folder; }
    };
    body.append(line(t.exportExplain), el("div", { className: "row" }, pick), folderLine, el("div", { className: "row" }, pass, go), result);
  };

  /** 끝 단계 — 파일 위치 + 「52글자를 종이에 적었는지」 확인이 되어야 끝낼 수 있다. */
  function showEnd(host: HTMLElement, r: Exported): void {
    const viewer = keyViewer();
    const ok = el("input", { type: "checkbox", id: "wf-end-ok", checked: paperDone() });
    const fin = el("button", { textContent: t.finish, id: "wf-end-fin", disabled: !ok.checked });
    ok.addEventListener("change", () => { fin.disabled = !ok.checked; });
    fin.onclick = () => {
      setPaperDone(true);
      viewer.hide();
      host.replaceChildren(line(`${t.wrote}  ${t.fileAt}: ${r.path ?? ""}`), line(t.finished));
      const m = document.getElementById("wf-paper-status"); if (m) m.textContent = t.paperDoneMark;
      const box = document.getElementById("wf-paper-ok") as HTMLInputElement | null; if (box) box.checked = true;
    };
    const path = el("p", { className: "meta" }, el("b", { textContent: `${t.fileAt}: ` }), el("span", { textContent: r.path ?? "" }));
    path.setAttribute("translate", "no");
    host.replaceChildren(
      line(`✔ ${t.wrote}`, "meta"), line(r.verified ? `✔ ${t.verified}` : ""), path,
      el("div", { className: "warnbox" },
        el("b", { textContent: t.endTitle }), el("br"), t.endNeed, viewer.root,
        el("div", { className: "row" },
          Object.assign(el("button", { className: "ghost", textContent: t.seeKeyAgain }), { onclick: () => void viewer.show().catch(() => {}) }),
          Object.assign(el("button", { className: "ghost", textContent: t.hideKey }), { onclick: viewer.hide })),
        el("label", { style: "display:flex;gap:8px;align-items:flex-start;margin-top:10px" }, ok, el("span", { textContent: t.endAsk })),
        el("div", { className: "row", style: "margin-top:10px" }, fin)));
  }

  importBtn.onclick = () => {
    reset();
    let file: string | null = null;
    const fileLine = line(t.fileNone);
    const out = el("div");
    const mk = el("input", { type: "radio", name: "wf-mode", value: "key", checked: true });
    const mp = el("input", { type: "radio", name: "wf-mode", value: "pass" });
    const secret = field("wf-im-secret", t.secretKey);
    const syncPh = () => { secret.placeholder = mp.checked ? t.secretPass : t.secretKey; };
    mk.addEventListener("change", syncPh); mp.addEventListener("change", syncPh);
    const open = el("button", { textContent: t.openIt, id: "wf-im-open", disabled: true });
    const pick = Object.assign(el("button", { className: "ghost", textContent: t.pickFile }), {
      onclick: async () => {
        const r = await pickPath({ multiple: false, directory: false, filters: [{ name: "RavenVault wallet", extensions: ["rvwallet"] }] }).catch(() => null);
        if (typeof r === "string") { file = r; fileLine.textContent = r; fileLine.setAttribute("translate", "no"); open.disabled = false; }
      },
    });
    const cancel = async () => { await invoke("wallet_import_cancel").catch(() => {}); secret.value = ""; reset(); body.append(line(t.canceled)); };
    open.onclick = async () => {
      if (!file || !secret.value) { out.replaceChildren(line(t.empty)); return; }
      open.disabled = true;
      try {
        const r = await invoke<Prepared>("wallet_import_prepare", { file, mode: mp.checked ? "pass" : "key", secret: secret.value });
        secret.value = "";
        showPrepared(out, r, cancel);
      } catch (e) { out.replaceChildren(line(errText(e), "meta warnbox")); }
      finally { secret.value = ""; open.disabled = !file; }
    };
    body.append(
      el("div", { className: "row" }, pick), fileLine,
      el("label", { className: "meta", style: "display:block" }, mk, " " + t.modeKey),
      el("label", { className: "meta", style: "display:block" }, mp, " " + t.modePass),
      el("div", { className: "row" }, secret, open), out);
  };

  function showPrepared(host: HTMLElement, r: Prepared, cancel: () => Promise<void>): void {
    const ok = el("input", { type: "checkbox", id: "wf-sw-ok" });
    const sw = el("button", { textContent: t.doSwitch, id: "wf-sw-go", disabled: true });
    ok.addEventListener("change", () => { sw.disabled = !ok.checked || !!r.same_as_current; });
    sw.onclick = async () => {
      sw.disabled = true;
      try {
        const a = await invoke<{ ok?: boolean; previous?: string | null; why?: string | null }>("wallet_import_apply", { id: r.id, confirmed: ok.checked });
        if (a.ok) {
          host.replaceChildren(line(`✔ ${t.switched}`), ...(a.previous ? [line(`${t.keptAt}: ${a.previous}`)] : []), line(t.restartApp));
        } else {
          host.replaceChildren(line(`${t.switchFailed}${a.why ? ` — ${a.why}` : ""}`, "meta warnbox"));
        }
      } catch (e) { host.replaceChildren(line(`${t.switchFailed} ${errText(e)}`, "meta warnbox")); }
    };
    host.replaceChildren(
      line(`✔ ${t.opened}`), line(`${t.fingerprint}: ${r.fingerprint ?? ""}`),
      r.same_as_current ? line(t.same, "meta warnbox") : line(t.currentKept),
      el("div", { className: "warnbox" }, t.importWarn),
      el("label", { style: "display:flex;gap:8px;align-items:flex-start;margin:10px 0" }, ok, el("span", { textContent: t.confirmSwitch })),
      el("div", { className: "row" }, sw, Object.assign(el("button", { className: "ghost", textContent: t.cancel }), { onclick: () => void cancel() })));
  }

  anchor.after(card);
}

export async function mountWalletFile(): Promise<void> {
  if (!document.getElementById("ck-key")) return;
  try { await mountPaperStep(); } catch { /* 종이 단계가 실패해도 아래 칸은 붙인다 */ }
  mountFileCard();
}

if (typeof document !== "undefined") {
  const go = () => {
    void mountWalletFile();
    // 트레이 메뉴의 대기화면 켜기가 지갑 암호 없어서 거절되면 큰 창에 안내를 띄운다(Rust → app-lock-refused).
    void listen<string>("app-lock-refused", (e) => { if (!handleLockRefusal(e.payload)) { /* 다른 이유는 조용히 */ } }).catch(() => {});
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
}
