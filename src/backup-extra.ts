// 백업과 복구 — 두 파일 구분표 · 끌어다 놓아 가져오기(.pxlock · .rvwallet) · 레이븐 코어로 옮기기(코어용 wallet.dat). (0.9.0)
//
// 지연 로딩 묶음: 설정의 백업 칸이 붙을 때(`wallet-file.ts` mountWalletFile)와 창에 백업 파일을 놓았을 때
// (`backup-drop-route.ts`)만 불러온다. index.html 은 건드리지 않는다 — 설정 「백업과 복구」 주제 패널(레인 A)이
// 마크업을 바꿔도 `#wf-card`·`#ck-key` 옆에 스스로 붙는다.
//
// 🔴 이 화면은 흐름만 안내한다. 지켜야 할 것은 Rust 가 지킨다:
//    - 코어용 wallet.dat: `walletfile::wallet_core_export` — 지갑 암호 있어야만 · 재인증 · 노드 스냅샷(backupwallet)만 ·
//      새 파일 · 다시 읽어 확인 · 잠긴 동안 거부.
//    - 끌어다 놓은 복원: `restore_drop.rs` — 읽기만 → 재인증+열어 보기 → 확인 뒤에만 기존 복원 함수.
// 🔴 열쇠·암호는 입력칸(value)에만 두고 쓰고 나면 비운다. innerHTML 을 쓰지 않는다. 확인되지 않은 코어 호환은 말하지 않는다.
import { invoke } from "@tauri-apps/api/core";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { lang, coreLang } from "./i18n";
import { el, errText, handleLockRefusal, showNeedPass } from "./wallet-file";
import { backupDropKind, type BackupDropKind } from "./backup-drop-route";

type L = "ko" | "en" | "ja" | "zh";

type Copy = {
  twoTitle: string; twoLede: string; rvCol: string; coreCol: string; rowFile: string; rowLock: string; rowOpens: string; rowWhen: string;
  rvFile: string; rvLock: string; rvOpens: string; rvWhen: string; coreFile: string; coreLock: string; coreOpens: string; coreWhen: string;
  dropTitle: string; dropLede: string; dropHint: string; dropPick: string;
  dlgTitle: string; dlgAsk: string; fileName: string; fileSize: string; fileDate: string;
  scopeFull: string; scopeWallet: string; one: string; mixed: string; prepare: string; cancel: string; close: string;
  modeKey: string; modePass: string; secretKey: string; secretPass: string; secretOptional: string; walletPass: string; openIt: string; opening: string;
  opened: string; inside: string; fingerprint: string; same: string; nodeOff: string; confirm: string; apply: string; applying: string;
  done: string; partial: string; failed: string; keptAt: string; keepNote: string; restart: string; canceled: string; empty: string;
  coreTitle: string; coreLede: string; coreSteps: string; coreStart: string;
  g1: string; g2: string; g3: string; g4: string; gRead: string; next: string;
  passAgain: string; pickFolder: string; folderNone: string; folderPicked: string; folderTip: string; doCore: string; working: string;
  wrote: string; verified: string; fileAt: string; fmtBdb: string; fmtSqlite: string; weak: string;
  coreTodo: string; t1: string; t2: string; t3: string; t4: string; notLocked: string; nodeDown: string;
};

const KO: Copy = {
  twoTitle: "파일로 꺼내는 길은 두 가지예요",
  twoLede: "둘 다 wallet.dat가 들어 있지만, 잠금과 여는 곳이 달라요. 평소 백업은 왼쪽 것을 쓰세요.",
  rvCol: "레이븐볼트용", coreCol: "레이븐 코어용",
  rowFile: "파일", rowLock: "잠금", rowOpens: "여는 곳", rowWhen: "쓸 때",
  rvFile: "wallet.dat 백업 파일(.rvwallet)", rvLock: "wallet.dat를 52글자 열쇠로 한 번 더 잠금", rvOpens: "레이븐볼트에서만", rvWhen: "평소 백업",
  coreFile: "코어용 wallet.dat", coreLock: "52글자 잠금 없음 — 지갑 암호만으로 보호", coreOpens: "레이븐 코어(함께 든 4.8.0으로 확인 · 버전에 따라 다를 수 있어요)", coreWhen: "레이븐 코어로 옮길 때만",
  dropTitle: "wallet.dat 백업 파일 가져오기 — 끌어다 놓기",
  dropLede: ".rvwallet(wallet.dat만) 또는 .pxlock(가게 전체 백업) 파일을 이 창 아무 곳에나 끌어다 놓으세요. 바로 바꾸지 않고, 먼저 무엇을 되살리는지 보여 드려요.",
  dropHint: "여기에 끌어다 놓으세요", dropPick: "파일 고르기…",
  dlgTitle: "백업 파일을 놓으셨어요", dlgAsk: "이 백업에서 되살릴까요?",
  fileName: "파일", fileSize: "크기", fileDate: "만든 날(파일 날짜)",
  scopeFull: "가게 전체 백업(.pxlock)이에요. 지갑(wallet.dat)과 가게 기록(가게·회원·이용권·예약·수업·주문·발송 기록 등)을 이 백업 때로 되돌려요. 지금 것은 지우지 않고 옆에 따로 남겨 둬요.",
  scopeWallet: "wallet.dat 백업 파일(.rvwallet)이에요. 지갑(wallet.dat) 하나만 바꿔요. 가게 기록과 설정은 그대로예요. 지금 지갑은 지우지 않고 먼저 따로 보관해요.",
  one: "백업 파일은 한 번에 하나씩 놓아 주세요.", mixed: "백업 파일과 다른 파일을 같이 놓으셨어요. 백업 파일만 봤어요 — 다른 파일은 따로 다시 놓아 주세요.",
  prepare: "되살리기 준비", cancel: "그만두기", close: "닫기",
  modeKey: "종이의 52글자 열쇠로 열기", modePass: "백업 암호로 열기", secretKey: "52글자 열쇠", secretPass: "백업 암호",
  secretOptional: "이 컴퓨터에서 만든 가게 전체 백업이면 비워 두어도 열려요.", walletPass: "지갑 암호 (본인 확인)", openIt: "열어 보기", opening: "확인하는 중…",
  opened: "열어 봤어요. 아직 아무것도 바꾸지 않았어요.", inside: "이 백업에 든 것", fingerprint: "지문(앞 8자리)",
  same: "지금 쓰는 지갑과 같은 파일이에요. 바꿀 필요가 없어요.",
  nodeOff: "되살리려면 레이븐 노드를 완전히 꺼야 해요(켜져 있으면 아무것도 바꾸지 않고 멈춰요). 같은 지갑을 두 컴퓨터에서 동시에 쓰지 마세요.",
  confirm: "노드를 껐고, 지금 것이 따로 보관된 뒤 이 백업으로 바뀐다는 것을 이해했어요", apply: "이 백업에서 되살리기", applying: "되살리는 중…",
  done: "되살렸어요.", partial: "일부만 되살렸어요. 아래 실패한 항목과 이전 파일 위치를 확인해 주세요.", failed: "되살리지 못했어요. 지금 것은 그대로예요.",
  keptAt: "이전 파일 보관 위치", keepNote: "보관한 이전 파일은 확인하기 전에는 지우지 마세요.", restart: "앱을 다시 켜고 노드를 시작하면 적용돼요.",
  canceled: "그만뒀어요. 지금 것은 그대로예요.", empty: "값을 넣어 주세요.",
  coreTitle: "레이븐 코어로 옮기기",
  coreLede: "레이븐볼트를 그만 쓰고 레이븐 코어(Raven Core)로 옮기실 때, 코어가 열 수 있는 「코어용 wallet.dat」을 꺼내 드려요. 언제든 떠날 수 있어야 믿고 쓸 수 있으니까요.",
  coreSteps: "① 안내 읽기  →  ② 지갑 암호 다시 확인  →  ③ 폴더 고르기  →  ④ 코어에서 할 일",
  coreStart: "코어용 wallet.dat 꺼내기…",
  g1: "코어에서 열려면 52글자로 잠그지 않은 wallet.dat 그대로가 필요해요.",
  g2: "이 파일 안의 개인키는 지갑 암호로 암호화돼 있어요. 주운 사람은 지갑 암호를 모르면 돈을 쓸 수 없어요.",
  g3: "하지만 지갑 암호가 짧거나 쉬우면 위험해요. 주소와 거래 내역은 지갑 암호 없이도 읽힐 수 있어요.",
  g4: "지갑 암호가 아직 없으면 먼저 「지갑」 화면에서 암호를 걸어야 해요.",
  gRead: "읽었어요", next: "다음",
  passAgain: "지갑 암호 한 번 더 입력", pickFolder: "저장할 폴더 고르기…", folderNone: "아직 고르지 않았어요", folderPicked: "저장할 폴더",
  folderTip: "USB처럼 내가 가지고 다니는 곳을 권해요. 파일 이름은 wallet-for-ravencoin-core-날짜.dat 이에요.",
  doCore: "코어용 wallet.dat 꺼내기", working: "노드에게 지갑 사본을 받아 저장하는 중… (다시 읽어 확인까지 해요)",
  wrote: "파일을 만들었어요.", verified: "노드가 만든 사본과 쓴 파일을 다시 읽어 비교했고, 같았어요.", fileAt: "파일 위치",
  fmtBdb: "형식: Berkeley DB 지갑 파일", fmtSqlite: "형식: SQLite 지갑 파일",
  weak: "지갑 암호가 10글자보다 짧아요. 이 파일은 지갑 암호로만 보호되니, 옮기기 전에 「지갑」 화면에서 더 긴 암호로 바꾸고 다시 꺼내 주세요.",
  coreTodo: "코어 쪽에서 할 일",
  t1: "레이븐 코어를 완전히 끈 상태에서, 코어의 데이터 폴더(지갑이 놓이는 자리)에 넣어 주세요. 정확한 자리와 이름은 코어 버전에 따라 다를 수 있어요.",
  t2: "코어를 켜면 지갑을 읽어요. 이 지갑으로 보내거나 개인키를 쓰려면 지갑 암호가 필요해요(암호는 파일에 들어 있지 않아요). 잔액은 코어가 블록체인을 다 받은(동기화) 뒤에 보여요 — 처음에는 오래 걸릴 수 있어요.",
  t3: "레이븐볼트에 함께 든 레이븐 코어(4.8.0)가 만든 이 파일이 같은 코어에서 열리는 것은 확인했어요. 다른 버전의 코어에서는 확인하지 못했어요 — 열리지 않거나 다르게 보일 수 있어요. 코어에서 열리고 잔액이 맞는 것을 보기 전까지 레이븐볼트 쪽 지갑을 지우지 마세요.",
  t4: "두 프로그램에서 같은 지갑을 동시에 쓰지 마세요.",
  notLocked: "이 파일은 52글자 열쇠로 잠기지 않아요. 보관이 끝나면 USB에서도 지우시고, 평소 백업은 위의 .rvwallet을 쓰세요.",
  nodeDown: "노드가 응답하지 않아 지갑 암호가 있는지 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.",
};

const EN: Copy = {
  twoTitle: "There are two ways to take your wallet out as a file",
  twoLede: "Both contain wallet.dat, but they are locked differently and open in different places. Use the left one for everyday backups.",
  rvCol: "For RavenVault", coreCol: "For Raven Core",
  rowFile: "File", rowLock: "Lock", rowOpens: "Opens in", rowWhen: "Use it",
  rvFile: "wallet.dat backup file (.rvwallet)", rvLock: "wallet.dat locked once more with the 52-character key", rvOpens: "RavenVault only", rvWhen: "Everyday backups",
  coreFile: "wallet.dat for Raven Core", coreLock: "No 52-character lock — protected only by the wallet password", coreOpens: "Raven Core (checked with the bundled 4.8.0 · may differ by version)", coreWhen: "Only when moving to Raven Core",
  dropTitle: "Import wallet.dat backup file — drag and drop",
  dropLede: "Drag a .rvwallet (wallet.dat only) or .pxlock (full shop backup) file anywhere onto this window. Nothing changes right away — first we show you what would be restored.",
  dropHint: "Drop it here", dropPick: "Choose a file…",
  dlgTitle: "You dropped a backup file", dlgAsk: "Restore from this backup?",
  fileName: "File", fileSize: "Size", fileDate: "Made on (file date)",
  scopeFull: "This is a full shop backup (.pxlock). It returns the wallet (wallet.dat) and shop records (shop, members, passes, bookings, classes, orders, delivery records, etc.) to the time of this backup. What you have now is not deleted; it is set aside.",
  scopeWallet: "This is a wallet.dat backup file (.rvwallet). Only the wallet (wallet.dat) is replaced. Shop records and settings stay as they are. Your current wallet is set aside first, not deleted.",
  one: "Please drop one backup file at a time.", mixed: "You dropped a backup file together with other files. Only the backup was looked at — drop the other files again separately.",
  prepare: "Prepare to restore", cancel: "Cancel", close: "Close",
  modeKey: "Open with the 52-character key from paper", modePass: "Open with the backup password", secretKey: "52-character key", secretPass: "Backup password",
  secretOptional: "A full shop backup made on this computer opens even if you leave this empty.", walletPass: "Wallet password (to confirm it is you)", openIt: "Open it", opening: "Checking…",
  opened: "Opened. Nothing has been changed yet.", inside: "In this backup", fingerprint: "Fingerprint (first 8)",
  same: "This is the same file as the wallet you use now. No need to switch.",
  nodeOff: "To restore, the Raven node must be fully stopped (if it is running, we stop without changing anything). Never use the same wallet on two computers at once.",
  confirm: "I stopped the node and understand what I have now is set aside before it is replaced by this backup", apply: "Restore from this backup", applying: "Restoring…",
  done: "Restored.", partial: "Only part was restored. Check the failed items and where the previous files are kept below.", failed: "Could not restore. What you have now is unchanged.",
  keptAt: "Previous files kept at", keepNote: "Do not delete the kept previous files until you have checked them.", restart: "Restart the app and start the node to apply it.",
  canceled: "Canceled. What you have now is unchanged.", empty: "Please enter a value.",
  coreTitle: "Move to Raven Core",
  coreLede: "If you stop using RavenVault and move to Raven Core, we give you a \"wallet.dat for Raven Core\" that Core can open. You should always be able to leave — that is why you can trust it.",
  coreSteps: "1. Read the notes  →  2. Confirm wallet password  →  3. Choose a folder  →  4. What to do in Core",
  coreStart: "Take out wallet.dat for Raven Core…",
  g1: "To open in Core you need the plain wallet.dat, not locked with the 52-character key.",
  g2: "The private keys in this file are encrypted with your wallet password. Someone who finds it cannot spend without the wallet password.",
  g3: "But a short or easy wallet password is risky. Addresses and transaction history can be read without the wallet password.",
  g4: "If the wallet has no password yet, set one on the Wallet screen first.",
  gRead: "I have read this", next: "Next",
  passAgain: "Enter the wallet password once more", pickFolder: "Choose a folder…", folderNone: "Not chosen yet", folderPicked: "Save to",
  folderTip: "A place you carry, like a USB drive, is recommended. The file is named wallet-for-ravencoin-core-DATE.dat.",
  doCore: "Take out wallet.dat for Raven Core", working: "Getting a wallet copy from the node and saving it… (includes reading back to verify)",
  wrote: "The file was created.", verified: "We read the saved file back and it matched the copy the node made.", fileAt: "File location",
  fmtBdb: "Format: Berkeley DB wallet file", fmtSqlite: "Format: SQLite wallet file",
  weak: "Your wallet password is shorter than 10 characters. This file is protected only by the wallet password — change it to a longer one on the Wallet screen and take the file out again before moving.",
  coreTodo: "What to do in Raven Core",
  t1: "With Raven Core fully closed, put it in Core's data folder (where the wallet goes). The exact place and name may differ by Core version.",
  t2: "When Core starts it reads the wallet. To send from this wallet or use its private keys you need the wallet password (it is not stored in the file). The balance appears only after Core has finished syncing the blockchain — the first time this can take a long time.",
  t3: "We confirmed that this file, made by the Raven Core (4.8.0) bundled with RavenVault, opens in that same Core. We have not checked other Core versions — it may not open or may look different. Do not delete the RavenVault wallet until it opens in Core and the balance is right.",
  t4: "Never use the same wallet in both programs at the same time.",
  notLocked: "This file is not locked with the 52-character key. When you are done, delete it from the USB drive too, and use the .rvwallet above for everyday backups.",
  nodeDown: "The node isn't responding, so we can't check whether the wallet has a password. Start the node and try again.",
};

const JA: Copy = {
  twoTitle: "ファイルとして取り出す方法は2つあります",
  twoLede: "どちらにも wallet.dat が入っていますが、ロックと開ける場所が違います。普段のバックアップは左を使ってください。",
  rvCol: "RavenVault 用", coreCol: "Raven Core 用",
  rowFile: "ファイル", rowLock: "ロック", rowOpens: "開ける場所", rowWhen: "使うとき",
  rvFile: "wallet.dat バックアップファイル（.rvwallet）", rvLock: "wallet.dat を52文字の鍵でもう一度ロック", rvOpens: "RavenVault だけ", rvWhen: "普段のバックアップ",
  coreFile: "Raven Core 用 wallet.dat", coreLock: "52文字のロックなし — ウォレットのパスワードだけで保護", coreOpens: "Raven Core（同梱の 4.8.0 で確認・バージョンによって異なる場合があります）", coreWhen: "Raven Core へ移るときだけ",
  dropTitle: "wallet.dat バックアップファイルの読み込み — ドラッグ＆ドロップ",
  dropLede: ".rvwallet（wallet.dat のみ）または .pxlock（店舗全体のバックアップ）ファイルを、このウィンドウのどこにでもドロップしてください。すぐには変えず、まず何を復元するかをお見せします。",
  dropHint: "ここにドロップ", dropPick: "ファイルを選ぶ…",
  dlgTitle: "バックアップファイルがドロップされました", dlgAsk: "このバックアップから復元しますか？",
  fileName: "ファイル", fileSize: "サイズ", fileDate: "作成日（ファイルの日付）",
  scopeFull: "店舗全体のバックアップ（.pxlock）です。ウォレット（wallet.dat）と店舗の記録（店舗・会員・利用券・予約・クラス・注文・発送記録など）をこのバックアップの時点に戻します。今のものは削除せず、別に残します。",
  scopeWallet: "wallet.dat バックアップファイル（.rvwallet）です。ウォレット（wallet.dat）だけを入れ替えます。店舗の記録と設定はそのままです。今のウォレットは削除せず、先に別に保管します。",
  one: "バックアップファイルは1つずつドロップしてください。", mixed: "バックアップファイルとほかのファイルを一緒にドロップしました。バックアップだけを見ました — ほかのファイルは別にもう一度ドロップしてください。",
  prepare: "復元の準備", cancel: "やめる", close: "閉じる",
  modeKey: "紙の52文字の鍵で開く", modePass: "バックアップパスワードで開く", secretKey: "52文字の鍵", secretPass: "バックアップパスワード",
  secretOptional: "このコンピュータで作った店舗全体のバックアップなら、空欄でも開けます。", walletPass: "ウォレットのパスワード（本人確認）", openIt: "開いてみる", opening: "確認中…",
  opened: "開きました。まだ何も変えていません。", inside: "このバックアップの中身", fingerprint: "指紋（先頭8桁）",
  same: "現在使っているウォレットと同じファイルです。切り替える必要はありません。",
  nodeOff: "復元するには Raven ノードを完全に停止する必要があります（起動中なら何も変えずに止まります）。同じウォレットを2台で同時に使わないでください。",
  confirm: "ノードを停止し、今のものが別に保管されてからこのバックアップに入れ替わることを理解しました", apply: "このバックアップから復元する", applying: "復元中…",
  done: "復元しました。", partial: "一部だけ復元しました。下の失敗した項目と以前のファイルの保管場所を確認してください。", failed: "復元できませんでした。今のものはそのままです。",
  keptAt: "以前のファイルの保管場所", keepNote: "保管した以前のファイルは、確認するまで削除しないでください。", restart: "アプリを再起動してノードを開始すると反映されます。",
  canceled: "やめました。今のものはそのままです。", empty: "値を入力してください。",
  coreTitle: "Raven Core へ移る",
  coreLede: "RavenVault をやめて Raven Core に移るとき、Core が開ける「Raven Core 用 wallet.dat」を取り出します。いつでも離れられることが、安心して使える理由です。",
  coreSteps: "① 案内を読む  →  ② ウォレットのパスワードを再確認  →  ③ フォルダを選ぶ  →  ④ Core ですること",
  coreStart: "Raven Core 用 wallet.dat を取り出す…",
  g1: "Core で開くには、52文字でロックしていない wallet.dat そのものが必要です。",
  g2: "このファイルの秘密鍵はウォレットのパスワードで暗号化されています。拾った人はパスワードを知らなければお金を使えません。",
  g3: "ただし、ウォレットのパスワードが短い・簡単だと危険です。アドレスと取引履歴はパスワードなしでも読める場合があります。",
  g4: "ウォレットにまだパスワードがなければ、先に「ウォレット」画面で設定してください。",
  gRead: "読みました", next: "次へ",
  passAgain: "ウォレットのパスワードをもう一度入力", pickFolder: "保存先フォルダを選ぶ…", folderNone: "まだ選んでいません", folderPicked: "保存先",
  folderTip: "USB のように持ち歩ける場所をおすすめします。ファイル名は wallet-for-ravencoin-core-日付.dat です。",
  doCore: "Raven Core 用 wallet.dat を取り出す", working: "ノードからウォレットのコピーを受け取って保存中…（読み直して確認するまで行います）",
  wrote: "ファイルを作成しました。", verified: "保存したファイルを読み直し、ノードが作ったコピーと同じことを確認しました。", fileAt: "ファイルの場所",
  fmtBdb: "形式：Berkeley DB ウォレットファイル", fmtSqlite: "形式：SQLite ウォレットファイル",
  weak: "ウォレットのパスワードが10文字より短いです。このファイルはパスワードだけで守られるので、移る前に「ウォレット」画面でもっと長いパスワードに変えてから、もう一度取り出してください。",
  coreTodo: "Raven Core ですること",
  t1: "Raven Core を完全に終了した状態で、Core のデータフォルダ（ウォレットを置く場所）に入れてください。正確な場所と名前は Core のバージョンによって異なる場合があります。",
  t2: "Core を起動するとウォレットを読み込みます。このウォレットから送金したり秘密鍵を使ったりするには、ウォレットのパスワードが必要です（パスワードはファイルに入っていません）。残高は Core がブロックチェーンの同期を終えてから表示されます。最初は長くかかることがあります。",
  t3: "RavenVault に同梱の Raven Core（4.8.0）が作ったこのファイルが、同じ Core で開けることは確認しました。ほかのバージョンの Core では確認していません。開けなかったり、違って見えたりすることがあります。Core で開いて残高が合うのを確認するまで、RavenVault 側のウォレットを削除しないでください。",
  t4: "2つのプログラムで同じウォレットを同時に使わないでください。",
  notLocked: "このファイルは52文字の鍵でロックされていません。保管が終わったら USB からも削除し、普段のバックアップは上の .rvwallet を使ってください。",
  nodeDown: "ノードが応答しないため、パスワードの有無を確認できません。ノードを起動してからもう一度お試しください。",
};

const ZH: Copy = {
  twoTitle: "以文件形式取出钱包有两种方式",
  twoLede: "两者都包含 wallet.dat，但加锁方式和能打开的地方不同。日常备份请使用左边的。",
  rvCol: "RavenVault 用", coreCol: "Raven Core 用",
  rowFile: "文件", rowLock: "加锁", rowOpens: "在哪里打开", rowWhen: "何时使用",
  rvFile: "wallet.dat 备份文件（.rvwallet）", rvLock: "用52个字符的密钥再锁一次 wallet.dat", rvOpens: "仅 RavenVault", rvWhen: "日常备份",
  coreFile: "Raven Core 用 wallet.dat", coreLock: "没有52个字符的锁——只由钱包密码保护", coreOpens: "Raven Core（已用随附的 4.8.0 确认·可能因版本而异）", coreWhen: "仅在迁移到 Raven Core 时",
  dropTitle: "导入 wallet.dat 备份文件——拖放",
  dropLede: "把 .rvwallet（仅 wallet.dat）或 .pxlock（整个店铺备份）文件拖到此窗口的任意位置。不会立即更改——先告诉您将恢复什么。",
  dropHint: "拖到这里", dropPick: "选择文件…",
  dlgTitle: "您拖入了一个备份文件", dlgAsk: "要从这个备份恢复吗？",
  fileName: "文件", fileSize: "大小", fileDate: "制作日期（文件日期）",
  scopeFull: "这是整个店铺备份（.pxlock）。会把钱包（wallet.dat）和店铺记录（店铺、会员、使用券、预约、课程、订单、发货记录等）恢复到这个备份的时间。现在的内容不会删除，而是另行保留。",
  scopeWallet: "这是 wallet.dat 备份文件（.rvwallet）。只替换钱包（wallet.dat）。店铺记录和设置保持不变。当前钱包不会删除，而是先另行保管。",
  one: "请一次只拖入一个备份文件。", mixed: "您把备份文件和其他文件一起拖入了。只查看了备份文件——其他文件请另外重新拖入。",
  prepare: "准备恢复", cancel: "取消", close: "关闭",
  modeKey: "用纸上的52个字符密钥打开", modePass: "用备份密码打开", secretKey: "52个字符的密钥", secretPass: "备份密码",
  secretOptional: "如果是在这台电脑上制作的整个店铺备份，留空也能打开。", walletPass: "钱包密码（身份确认）", openIt: "打开查看", opening: "正在确认…",
  opened: "已打开。还没有更改任何内容。", inside: "这个备份里有什么", fingerprint: "指纹（前8位）",
  same: "这与您正在使用的钱包是同一个文件，无需切换。",
  nodeOff: "恢复前必须完全停止 Raven 节点（如果正在运行，会在不做任何更改的情况下停止）。请勿在两台电脑上同时使用同一个钱包。",
  confirm: "我已停止节点，并明白现在的内容会先被另行保管，然后替换为这个备份", apply: "从这个备份恢复", applying: "正在恢复…",
  done: "已恢复。", partial: "只恢复了一部分。请查看下面失败的项目和原文件的保管位置。", failed: "无法恢复。现在的内容保持不变。",
  keptAt: "原文件保管位置", keepNote: "在确认之前，请不要删除保管的原文件。", restart: "重启应用并启动节点后生效。",
  canceled: "已取消。现在的内容保持不变。", empty: "请输入内容。",
  coreTitle: "迁移到 Raven Core",
  coreLede: "当您不再使用 RavenVault、迁移到 Raven Core 时，我们会取出 Core 可以打开的“Raven Core 用 wallet.dat”。随时都能离开，才值得信赖。",
  coreSteps: "① 阅读说明  →  ② 再次确认钱包密码  →  ③ 选择文件夹  →  ④ 在 Core 中要做的事",
  coreStart: "取出 Raven Core 用 wallet.dat…",
  g1: "要在 Core 中打开，需要未用52个字符加锁的 wallet.dat 本身。",
  g2: "此文件中的私钥已用钱包密码加密。捡到的人如果不知道钱包密码就无法花钱。",
  g3: "但如果钱包密码太短或太简单就有风险。地址和交易记录不需要钱包密码也可能被读取。",
  g4: "如果钱包还没有密码，请先在“钱包”页面设置。",
  gRead: "我已阅读", next: "下一步",
  passAgain: "再输入一次钱包密码", pickFolder: "选择保存文件夹…", folderNone: "尚未选择", folderPicked: "保存到",
  folderTip: "建议选择 U 盘这类随身携带的位置。文件名为 wallet-for-ravencoin-core-日期.dat。",
  doCore: "取出 Raven Core 用 wallet.dat", working: "正在从节点获取钱包副本并保存…（包括重新读取验证）",
  wrote: "文件已生成。", verified: "已重新读取保存的文件，并确认与节点生成的副本一致。", fileAt: "文件位置",
  fmtBdb: "格式：Berkeley DB 钱包文件", fmtSqlite: "格式：SQLite 钱包文件",
  weak: "您的钱包密码少于10个字符。此文件只由钱包密码保护——迁移前请在“钱包”页面改成更长的密码，然后重新取出。",
  coreTodo: "在 Raven Core 中要做的事",
  t1: "在完全关闭 Raven Core 的状态下，把它放进 Core 的数据文件夹（放钱包的位置）。确切的位置和名称可能因 Core 版本而异。",
  t2: "Core 启动后会读取钱包。要从这个钱包转账或使用私钥，需要钱包密码（密码不在文件里）。余额要等 Core 同步完区块链后才会显示，第一次可能需要很长时间。",
  t3: "我们已确认：由 RavenVault 随附的 Raven Core（4.8.0）生成的这个文件可以在同一个 Core 中打开。其他版本的 Core 尚未确认——可能无法打开或显示不同。在 Core 中打开并确认余额正确之前，请不要删除 RavenVault 这边的钱包。",
  t4: "请勿在两个程序中同时使用同一个钱包。",
  notLocked: "此文件没有用52个字符的密钥加锁。保管完成后，请也从 U 盘中删除，日常备份请使用上面的 .rvwallet。",
  nodeDown: "节点没有响应，无法确认钱包是否有密码。请启动节点后重试。",
};

const COPY: Record<L, Copy> = { ko: KO, en: EN, ja: JA, zh: ZH };
const c = (): Copy => COPY[coreLang(lang)] ?? EN;
/** 시험·재사용용 — 모르는 말(유럽어 포함)은 영어. */
export const backupExtraCopy = (l: string): Copy => COPY[l as L] ?? EN;

const line = (text: string, cls = "meta") => el("p", { className: cls, textContent: text });
const btn = (text: string, id: string, ghost = false) => el("button", { textContent: text, id, className: ghost ? "ghost" : "" });
const secretField = (id: string, ph: string) => {
  const i = el("input", { type: "password", id, placeholder: ph, autocomplete: "off" });
  i.setAttribute("spellcheck", "false");
  i.style.cssText = "flex:1;min-width:200px";
  return i;
};

function sizeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n < 1_048_576) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

function dayText(secs: number): string {
  if (!secs) return "-";
  try { return new Date(secs * 1000).toLocaleString(coreLang(lang) === "ko" ? "ko-KR" : coreLang(lang)); } catch { return new Date(secs * 1000).toISOString(); }
}

// ───────────────────────── 두 파일 구분표 ─────────────────────────

function mountTwoFiles(): void {
  const ckCard = document.getElementById("ck-key")?.closest(".card");
  if (!ckCard || document.getElementById("bk-two-files")) return;
  const t = c();
  const cell = (text: string, head = false) => el(head ? "b" : "span", { textContent: text });
  const grid = el("div", { className: "bkgrid", id: "bk-two-grid" },
    el("div", { className: "bkrow bkhead" }, cell(""), cell(t.rvCol, true), cell(t.coreCol, true)),
    el("div", { className: "bkrow" }, cell(t.rowFile, true), cell(t.rvFile), cell(t.coreFile)),
    el("div", { className: "bkrow" }, cell(t.rowLock, true), cell(t.rvLock), cell(t.coreLock)),
    el("div", { className: "bkrow" }, cell(t.rowOpens, true), cell(t.rvOpens), cell(t.coreOpens)),
    el("div", { className: "bkrow" }, cell(t.rowWhen, true), cell(t.rvWhen), cell(t.coreWhen)));
  const box = el("div", { id: "bk-two-files", className: "card", style: "margin-top:12px" },
    el("h3", { textContent: t.twoTitle, style: "margin-top:0" }), line(t.twoLede), grid);
  ckCard.before(box);
}

// ───────────────────────── 끌어다 놓기 칸 ─────────────────────────

function mountDropCard(after: Element): HTMLElement | null {
  if (document.getElementById("wf-drop")) return document.getElementById("wf-drop");
  const t = c();
  const pick = btn(t.dropPick, "wf-drop-pick", true);
  pick.onclick = async () => {
    const r = await pickPath({ multiple: false, directory: false, filters: [{ name: "RavenVault backup", extensions: ["rvwallet", "pxlock", "잠김"] }] }).catch(() => null);
    if (typeof r === "string") openRestoreDialog([r], 1);
  };
  const zone = el("div", { id: "wf-drop-zone", className: "warnbox", textContent: t.dropHint, style: "text-align:center;padding:22px 12px;border-style:dashed" });
  const card = el("div", { id: "wf-drop", className: "card", style: "margin-top:12px" },
    el("h3", { textContent: t.dropTitle, style: "margin-top:0" }), line(t.dropLede), zone, el("div", { className: "row", style: "margin-top:8px" }, pick));
  after.after(card);
  return card;
}

// ───────────────────────── 레이븐 코어로 옮기기 ─────────────────────────

type CoreOut = { path?: string; size?: number; format?: string; verified?: boolean; weak_pass?: boolean };
type Status = { node_up?: boolean; wallet_encrypted?: boolean | null };

function mountCoreCard(after: Element): void {
  if (document.getElementById("wf-core")) return;
  const t = c();
  const body = el("div", { id: "wf-core-body" });
  const start = btn(t.coreStart, "wf-core-start", true);
  const card = el("div", { id: "wf-core", className: "card", style: "margin-top:12px" },
    el("h3", { textContent: t.coreTitle, style: "margin-top:0" }), line(t.coreLede),
    el("p", { className: "meta" }, el("b", { textContent: t.coreSteps })),
    el("div", { className: "row" }, start), body);
  after.after(card);

  start.onclick = async () => {
    body.textContent = "";
    const st = await invoke<Status>("wallet_file_status").catch(() => null);
    if (!st || st.node_up === false) { body.append(line(t.nodeDown, "meta warnbox")); return; }
    if (st.wallet_encrypted === false) { showNeedPass(); body.append(line(t.g4, "meta warnbox")); return; }
    // ① 안내
    const read = el("input", { type: "checkbox", id: "wf-core-read" });
    const next1 = el("button", { textContent: t.next, id: "wf-core-next1", disabled: true });
    read.addEventListener("change", () => { next1.disabled = !read.checked; });
    const guide = el("ul", { className: "meta", id: "wf-core-guide" }, el("li", { textContent: t.g1 }), el("li", { textContent: t.g2 }), el("li", { textContent: t.g3 }), el("li", { textContent: t.g4 }));
    body.append(guide, el("label", { className: "meta", style: "display:flex;gap:8px;align-items:flex-start" }, read, el("span", { textContent: t.gRead })), el("div", { className: "row" }, next1));
    next1.onclick = () => step2();
  };

  // ② 지갑 암호 다시 입력 → ③ 폴더 → 꺼내기(Rust 가 재인증부터 다시 한다)
  function step2(): void {
    body.textContent = "";
    const pass = secretField("wf-core-pass", t.passAgain);
    let folder: string | null = null;
    const folderLine = line(`${t.folderPicked}: ${t.folderNone}`);
    folderLine.setAttribute("translate", "no");
    const go = el("button", { textContent: t.doCore, id: "wf-core-go", disabled: true });
    const result = el("div", { id: "wf-core-result" });
    const pick = Object.assign(btn(t.pickFolder, "wf-core-pick", true), {
      onclick: async () => {
        const f = await pickPath({ directory: true, multiple: false }).catch(() => null);
        if (typeof f === "string") { folder = f; folderLine.textContent = `${t.folderPicked}: ${f}`; go.disabled = false; }
      },
    });
    go.onclick = async () => {
      if (!folder || !pass.value) { result.replaceChildren(line(t.empty)); return; }
      go.disabled = true;
      result.replaceChildren(line(t.working));
      try {
        const r = await invoke<CoreOut>("wallet_core_export", { dest: folder, walletPass: pass.value });
        pass.value = "";
        showCoreDone(r);
      } catch (e) {
        if (!handleLockRefusal(e)) result.replaceChildren(line(errText(e), "meta warnbox"));
        else result.replaceChildren();
      } finally { pass.value = ""; go.disabled = !folder; }
    };
    body.append(el("div", { className: "row" }, pass), el("div", { className: "row" }, pick), folderLine, line(t.folderTip), el("div", { className: "row" }, go), result);
  }

  // ④ 결과 + 코어에서 할 일
  function showCoreDone(r: CoreOut): void {
    const path = el("p", { className: "meta" }, el("b", { textContent: `${t.fileAt}: ` }), el("span", { textContent: r.path ?? "" }));
    path.setAttribute("translate", "no");
    const fmt = r.format === "bdb" ? t.fmtBdb : r.format === "sqlite" ? t.fmtSqlite : "";
    body.replaceChildren(
      line(`✔ ${t.wrote}`), r.verified ? line(`✔ ${t.verified}`) : line(""), path,
      line(`${sizeText(Number(r.size || 0))}${fmt ? ` · ${fmt}` : ""}`),
      ...(r.weak_pass ? [el("div", { className: "warnbox", id: "wf-core-weak", textContent: t.weak })] : []),
      el("div", { className: "warnbox", id: "wf-core-unlocked", textContent: t.notLocked }),
      el("h4", { textContent: t.coreTodo }),
      el("ol", { className: "meta", id: "wf-core-todo" }, el("li", { textContent: t.t1 }), el("li", { textContent: t.t2 }), el("li", { textContent: t.t3 }), el("li", { textContent: t.t4 })));
  }
}

let langHooked = false;

/** 설정의 백업 칸에 구분표·끌어다 놓기·코어로 옮기기를 붙인다(이미 있으면 그대로). */
export function mountBackupExtras(): void {
  const wf = document.getElementById("wf-card");
  if (!wf) return;
  try { mountTwoFiles(); } catch { /* 표가 실패해도 아래 칸은 붙인다 */ }
  const drop = mountDropCard(wf) ?? wf;
  mountCoreCard(drop);
  if (langHooked) return;
  langHooked = true;
  // 화면 말을 바꾸면 고정 칸은 새 말로 다시 그린다. 코어로 옮기기가 진행 중이면(입력·결과가 있으면) 그 칸은 그대로 둔다.
  window.addEventListener("desktop-language-change", () => {
    const busy = !!document.getElementById("wf-core-body")?.childElementCount;
    document.getElementById("bk-two-files")?.remove();
    document.getElementById("wf-drop")?.remove();
    if (!busy) document.getElementById("wf-core")?.remove();
    const card = document.getElementById("wf-card");
    if (!card) return;
    try { mountTwoFiles(); } catch { /* 그대로 */ }
    const d = mountDropCard(card) ?? card;
    if (!busy) mountCoreCard(d);
    else { const core = document.getElementById("wf-core"); if (core) d.after(core); }
  });
}

// ───────────────────────── 끌어다 놓은 백업 → 확인 창 ─────────────────────────

type Inspect = { kind?: BackupDropKind; name?: string; path?: string; size?: number; modified?: number; scope?: string };
type Opened = { ticket?: string; kind?: BackupDropKind; items?: { key?: string; what?: string; detail?: string; why?: string }[]; fingerprint?: string; same_as_current?: boolean };
type Applied = { ok?: boolean; status?: string; done?: { what?: string; previous?: string | null }[]; failed?: { what?: string; why?: string; previous?: string | null }[]; previous?: string | null; why?: string | null };

let dialogOpen = false;

/** 놓은 백업 파일로 확인 창을 연다. 절대 바로 바꾸지 않는다. `total`: 함께 놓은 파일 수. */
export function openRestoreDialog(paths: string[], total = paths.length): void {
  document.getElementById("rd-dialog")?.remove();
  const t = c();
  const body = el("div", { id: "rd-body" });
  const closeBtn = btn(t.close, "rd-close", true);
  const box = el("div", { id: "rd-dialog", className: "card" },
    el("h3", { textContent: t.dlgTitle, id: "rd-title", style: "margin-top:0" }), body, el("div", { className: "row", style: "margin-top:10px;justify-content:flex-end" }, closeBtn));
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "rd-title");
  Object.assign(box.style, { position: "fixed", left: "50%", top: "8%", transform: "translateX(-50%)", zIndex: "9999", width: "min(92vw,600px)", maxHeight: "84vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,.35)" });
  // 입력칸의 열쇠·암호는 창을 닫을 때 비운다(창과 함께 DOM 에서 사라진다).
  const close = async (sayCanceled = false) => {
    box.querySelectorAll<HTMLInputElement>("input[type=password]").forEach((i) => { i.value = ""; });
    await invoke("restore_drop_cancel").catch(() => {});
    box.remove();
    dialogOpen = false;
    if (sayCanceled) { /* 조용히 닫는다 — 지금 것은 처음부터 그대로다 */ }
  };
  closeBtn.onclick = () => void close(true);
  box.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") void close(true); });
  document.body.append(box);
  dialogOpen = true;
  closeBtn.focus();

  if (paths.length !== 1) { body.append(line(t.one, "meta warnbox")); return; }
  const path = paths[0];
  if (total > 1) body.append(line(t.mixed, "meta warnbox"));
  void (async () => {
    let info: Inspect;
    try { info = await invoke<Inspect>("restore_drop_inspect", { path }); }
    catch (e) { body.append(line(errText(e), "meta warnbox")); return; }
    const kind: BackupDropKind = info.kind === "full" || info.kind === "wallet" ? info.kind : (backupDropKind(path) ?? "wallet");
    const facts = el("div", { id: "rd-facts" },
      el("p", { className: "meta" }, el("b", { textContent: `${t.fileName}: ` }), Object.assign(el("span", { textContent: info.name ?? "" }), { translate: false })),
      line(`${t.fileSize}: ${sizeText(Number(info.size || 0))}`),
      line(`${t.fileDate}: ${dayText(Number(info.modified || 0))}`));
    const scope = el("div", { className: "warnbox", id: "rd-scope", textContent: kind === "full" ? t.scopeFull : t.scopeWallet });
    scope.dataset.kind = kind;
    const ask = el("p", {}, el("b", { textContent: t.dlgAsk }));
    const prep = btn(t.prepare, "rd-prepare");
    const stop = btn(t.cancel, "rd-cancel", true);
    stop.onclick = () => void close(true);
    body.append(facts, scope, ask, el("div", { className: "row" }, prep, stop));
    prep.focus();
    prep.onclick = () => askSecrets(kind, String(info.path || path));
  })();

  // 열쇠(또는 백업 암호) + 지갑 암호 → 열어 보기(아직 아무것도 안 바꿈).
  function askSecrets(kind: BackupDropKind, filePath: string): void {
    const mk = el("input", { type: "radio", name: "rd-mode", value: "key", checked: true });
    const mp = el("input", { type: "radio", name: "rd-mode", value: "pass" });
    const secret = secretField("rd-secret", t.secretKey);
    const syncPh = () => { secret.placeholder = mp.checked ? t.secretPass : t.secretKey; };
    mk.addEventListener("change", syncPh); mp.addEventListener("change", syncPh);
    const wpass = secretField("rd-wallet-pass", t.walletPass);
    const open = btn(t.openIt, "rd-open");
    const out = el("div", { id: "rd-out" });
    const scope = el("div", { className: "warnbox", textContent: kind === "full" ? t.scopeFull : t.scopeWallet });
    body.replaceChildren(scope,
      el("label", { className: "meta", style: "display:block" }, mk, " " + t.modeKey),
      el("label", { className: "meta", style: "display:block" }, mp, " " + t.modePass),
      el("div", { className: "row" }, secret), ...(kind === "full" ? [line(t.secretOptional)] : []),
      el("div", { className: "row" }, wpass), el("div", { className: "row" }, open), out);
    secret.focus();
    open.onclick = async () => {
      if ((kind === "wallet" && !secret.value) || !wpass.value) { out.replaceChildren(line(t.empty)); return; }
      open.disabled = true;
      out.replaceChildren(line(t.opening));
      try {
        const r = await invoke<Opened>("restore_drop_open", { path: filePath, mode: mp.checked ? "pass" : "key", secret: secret.value, walletPass: wpass.value });
        wpass.value = "";
        // .rvwallet 은 1단계에서 이미 풀어 두었으니 열쇠가 더 필요 없다 — 바로 비운다. .pxlock 은 되살릴 때 한 번 더 연다.
        if (kind === "wallet") secret.value = "";
        showOpened(kind, r, secret);
      } catch (e) { out.replaceChildren(line(errText(e), "meta warnbox")); }
      finally { wpass.value = ""; open.disabled = false; }
    };
  }

  // 무엇이 들었나 + 확인 체크 → 되살리기(기존 복원 함수).
  function showOpened(kind: BackupDropKind, r: Opened, secret: HTMLInputElement): void {
    const ok = el("input", { type: "checkbox", id: "rd-ok" });
    const go = el("button", { textContent: t.apply, id: "rd-apply", disabled: true });
    const result = el("div", { id: "rd-result" });
    ok.addEventListener("change", () => { go.disabled = !ok.checked || !!r.same_as_current; });
    const list = el("div", { id: "rd-items" }, ...(r.items ?? []).map((i) => el("div", { className: "kv" }, el("b", { textContent: `${i.what ?? ""} ${i.detail ?? ""}`.trim() }), el("span", { textContent: i.why ?? "" }))));
    const secretRow = secret.closest(".row");
    if (secretRow) (secretRow as HTMLElement).style.display = "none"; // 열쇠는 칸에만 두고(.pxlock 되살릴 때 씀) 다시 보이지 않게
    const stop = btn(t.cancel, "rd-cancel2", true);
    stop.onclick = () => void close(true);
    body.replaceChildren(
      line(`✔ ${t.opened}`), el("h4", { textContent: t.inside }), list,
      ...(r.fingerprint ? [line(`${t.fingerprint}: ${r.fingerprint}`)] : []),
      ...(r.same_as_current ? [line(t.same, "meta warnbox")] : []),
      el("div", { className: "warnbox", id: "rd-scope2", textContent: kind === "full" ? t.scopeFull : t.scopeWallet }),
      el("div", { className: "warnbox", textContent: t.nodeOff }),
      el("label", { style: "display:flex;gap:8px;align-items:flex-start;margin:10px 0" }, ok, el("span", { textContent: t.confirm })),
      el("div", { className: "row" }, go, stop), result);
    if (secretRow) body.append(secretRow);
    go.onclick = async () => {
      go.disabled = true;
      result.replaceChildren(line(t.applying));
      try {
        const a = await invoke<Applied>("restore_drop_apply", { ticket: r.ticket, secret: kind === "full" ? secret.value : "", confirmed: ok.checked });
        secret.value = "";
        showApplied(a);
      } catch (e) {
        // 노드가 켜져 있으면 아무것도 안 바뀌었다 — 끄고 다시 누르면 된다(표는 그대로).
        result.replaceChildren(line(errText(e), "meta warnbox"));
        go.disabled = !ok.checked;
      }
    };
  }

  function showApplied(a: Applied): void {
    const done = Array.isArray(a.done) ? a.done : [];
    const failed = Array.isArray(a.failed) ? a.failed : [];
    const kept = [...done, ...failed].map((d) => d.previous).filter((p): p is string => typeof p === "string" && !!p);
    if (a.previous && !kept.includes(a.previous)) kept.push(a.previous);
    const title = a.ok ? t.done : (done.length ? t.partial : t.failed);
    body.replaceChildren(
      line(`${a.ok ? "✔ " : ""}${title}`, a.ok ? "meta" : "meta warnbox"),
      ...done.map((d) => line(`✔ ${d.what ?? ""}`)),
      ...failed.map((f) => line(`${f.what ?? ""} — ${f.why ?? ""}`, "meta warnbox")),
      ...(a.why ? [line(a.why, "meta warnbox")] : []),
      ...kept.map((p) => { const x = el("p", { className: "meta" }, el("b", { textContent: `${t.keptAt}: ` }), el("span", { textContent: p })); x.setAttribute("translate", "no"); return x; }),
      ...(kept.length ? [line(t.keepNote)] : []),
      ...(a.ok || done.length ? [line(t.restart)] : []));
  }
}

/** 시험용 — 확인 창이 열려 있나. */
export const restoreDialogOpen = (): boolean => dialogOpen;
