/*
 * 끌어놓기 발행 화면·판매 페이지 템플릿 문구(한 곳).
 *
 * 앱 사전(src/dict.ts)은 ko·en·ja·zh 네 말이고 열쇠가 한국어 원문이다. 이 화면은 새 문구가 많고 독일어·러시아어처럼
 * 긴 말에서 레이아웃이 깨지지 않는지 시험해야 해서, 열쇠 이름을 쓰는 작은 표를 따로 둔다(ko·en·de·ru).
 * 용어는 ~/rv-i18n/glossary.json 의 쉬운 말과 맞췄다(소각 = Burn/verbrennen/сжечь, 발행 = Issue/Ausgabe/выпуск,
 * 미검증 = Unverified/Nicht verifiziert/Не проверено, 장터 = Market/Marktplatz/торговая площадка, 수수료 별도 등).
 * de·ru 는 번역가 검수 전 초안(glossary reviewed:false 와 같은 상태) — 레이아웃 시험용으로 먼저 넣었다.
 * ja·zh 는 아직 이 표에 없어 한국어 원문을 앱 사전(t)에 넘긴다(사전에 없으면 한국어 그대로 — 앱 전체 규칙).
 */

export type DropLang = 'ko' | 'en' | 'de' | 'ru';
export const DROP_LANGS: readonly DropLang[] = ['ko', 'en', 'de', 'ru'];

const ko = {
  title: '내 상품 올리기',
  emptyTitle: '여기에 놓으면 상품이 만들어져요',
  emptySay: '음악·책·게임 폴더·그림을 이 창 어디에나 끌어다 놓으세요.',
  pick: '파일 고르기',
  pickFolder: '폴더 고르기',
  pasteLabel: 'IPFS 주소 붙여넣기',
  pastePlaceholder: 'ipfs://Qm…',
  pasteGo: '불러오기',
  overlay: '여기에 놓으면 상품이 만들어져요',
  overlaySay: '놓기만 하세요. 종류·이름·표지는 알아서 채워요.',
  detecting: '무엇인지 알아보는 중…',
  ask: '하나만 알려 주세요',
  previewHead: '구매자는 이렇게 봐요',
  checks: '자동 점검',
  costLine: '등록할 때 한 번: 보증(소각) {burn} RVN + 네트워크 수수료 약 {net} RVN · 팔릴 때: 수수료 {fee}%({feeSource})',
  costLineFree: '등록할 때 한 번: 보증(소각) {burn} RVN + 네트워크 수수료 약 {net} RVN · 무료 상품이라 판매 수수료 없음',
  publish: '발행',
  publishing: '발행하는 중…',
  advanced: '고급',
  detail: '자세히(단계별로)',
  startOver: '다른 것 올리기',
  close: '닫기',
  confirmTitle: '발행하면 되돌릴 수 없어요',
  confirmGo: '발행하기',
  confirmCancel: '취소',
  doneTitle: '발행했어요',
  doneSay: '장터에서 「{name}」(으)로 찾을 수 있어요.',
  blockedTitle: '지금은 발행할 수 없어요',
  resumeSay: '지난번 올리던 「{title}」이(가) 있어요.',
  resumeGo: '이어서 하기',
  resumeDrop: '지우기',
  name: '상품 등록증 이름',
  titleField: '제목',
  tagline: '한 줄 소개',
  description: '설명',
  tags: '태그(쉼표로 구분, 3개까지)',
  genre: '장르',
  price: '가격(RVN, 비우면 무료)',
  kind: '종류',
  template: '모양(템플릿)',
  theme: '색',
  coverDrop: '표지 그림을 여기에 끌어다 놓거나 눌러서 고르기',
  trackOrder: '곡 순서·곡명',
  previewRange: '미리듣기 구간(초)',
  up: '위로', down: '아래로',
  pass: '통과', warn: '주의', block: '막힘',
  free: '무료',
  tracks: '곡 목록',
  previewListen: '미리듣기',
  pages: '{n}쪽',
  previewPages: '미리보기 {n}쪽',
  quantity: '{n}장',
  unverifiedBadge: '보증 · 미검증',
  verifiedBadge: '검증됨',
  unverifiedWarning: '레이븐볼트가 내용을 검토하지 않은 판매자예요. 환불·배송·입장 책임은 판매자에게 있어요.',
  officialWarning: '공식 상품이 아니에요.',
  similarWarning: '비슷한 이름이 있어요: {names}',
  testOnly: '시험 단계 — 실제 메인넷 발행은 꺼져 있어요.',
  format_single: '싱글', format_ep: 'EP', format_album: '앨범',
  kind_game: '게임', kind_music: '음악', kind_book: '책', kind_ticket: '티켓', kind_digital: '그림·파일 모음', kind_shop: '가게',
  menu: '메뉴',
};
export type CopyKey = keyof typeof ko;

const en: Record<CopyKey, string> = {
  title: 'Sell my work', emptyTitle: 'Drop here to make a product', emptySay: 'Drag music, a book, a game folder or pictures anywhere onto this window.',
  pick: 'Choose files', pickFolder: 'Choose a folder', pasteLabel: 'Paste an IPFS address', pastePlaceholder: 'ipfs://Qm…', pasteGo: 'Load',
  overlay: 'Drop here to make a product', overlaySay: 'Just drop it. Kind, name and cover are filled in for you.', detecting: 'Finding out what this is…',
  ask: 'Just one question', previewHead: 'What buyers will see', checks: 'Automatic checks',
  costLine: 'Once, when issuing: deposit (burn) {burn} RVN + network fee about {net} RVN · When sold: fee {fee}% ({feeSource})',
  costLineFree: 'Once, when issuing: deposit (burn) {burn} RVN + network fee about {net} RVN · Free item, so no sales fee',
  publish: 'Publish', publishing: 'Publishing…', advanced: 'Advanced', detail: 'Step by step', startOver: 'Sell something else', close: 'Close',
  confirmTitle: 'Publishing cannot be undone', confirmGo: 'Publish now', confirmCancel: 'Cancel', doneTitle: 'Published',
  doneSay: 'Find it in the market as “{name}”.', blockedTitle: 'You can’t publish yet', resumeSay: 'You were in the middle of “{title}”.',
  resumeGo: 'Continue', resumeDrop: 'Discard', name: 'Asset name', titleField: 'Title', tagline: 'One-line intro', description: 'Description',
  tags: 'Tags (comma separated, up to 3)', genre: 'Genre', price: 'Price (RVN, empty = free)', kind: 'Kind', template: 'Layout (template)', theme: 'Colour',
  coverDrop: 'Drag a cover picture here or click to choose', trackOrder: 'Track order and titles', previewRange: 'Preview clip (seconds)',
  up: 'Up', down: 'Down', pass: 'Passed', warn: 'Caution', block: 'Blocked', free: 'Free', tracks: 'Tracks', previewListen: 'Preview',
  pages: '{n} pages', previewPages: '{n}-page preview', quantity: '{n} tickets', unverifiedBadge: 'Deposit · Unverified', verifiedBadge: 'Verified',
  unverifiedWarning: 'RavenVault has not reviewed this seller. Refunds, delivery and entry are the seller’s responsibility.',
  officialWarning: 'Not an official product.', similarWarning: 'Similar names exist: {names}', testOnly: 'Test stage — real mainnet issuing is off.',
  format_single: 'Single', format_ep: 'EP', format_album: 'Album', kind_game: 'Game', kind_music: 'Music', kind_book: 'Book', kind_ticket: 'Ticket',
  kind_digital: 'Pictures & files', kind_shop: 'Shop', menu: 'Menu',
};

const de: Record<CopyKey, string> = {
  title: 'Meine Werke verkaufen', emptyTitle: 'Hier ablegen, um ein Produkt zu erstellen', emptySay: 'Ziehen Sie Musik, ein Buch, einen Spieleordner oder Bilder irgendwo auf dieses Fenster.',
  pick: 'Dateien auswählen', pickFolder: 'Ordner auswählen', pasteLabel: 'IPFS-Adresse einfügen', pastePlaceholder: 'ipfs://Qm…', pasteGo: 'Laden',
  overlay: 'Hier ablegen, um ein Produkt zu erstellen', overlaySay: 'Einfach ablegen. Art, Name und Titelbild werden automatisch ausgefüllt.',
  detecting: 'Wird erkannt…', ask: 'Nur eine Frage', previewHead: 'So sehen Käuferinnen und Käufer es', checks: 'Automatische Prüfungen',
  costLine: 'Einmalig bei der Ausgabe: Kaution (verbrennen) {burn} RVN + Netzwerkgebühr ca. {net} RVN · Beim Verkauf: Marktplatzgebühr {fee} % ({feeSource})',
  costLineFree: 'Einmalig bei der Ausgabe: Kaution (verbrennen) {burn} RVN + Netzwerkgebühr ca. {net} RVN · Kostenloses Produkt, daher keine Verkaufsgebühr',
  publish: 'Veröffentlichen', publishing: 'Wird veröffentlicht…', advanced: 'Erweitert', detail: 'Schritt für Schritt', startOver: 'Etwas anderes verkaufen', close: 'Schließen',
  confirmTitle: 'Die Veröffentlichung kann nicht rückgängig gemacht werden', confirmGo: 'Jetzt veröffentlichen', confirmCancel: 'Abbrechen', doneTitle: 'Veröffentlicht',
  doneSay: 'Sie finden es auf dem Marktplatz als „{name}“.', blockedTitle: 'Veröffentlichen ist noch nicht möglich', resumeSay: 'Sie waren mitten in „{title}“.',
  resumeGo: 'Fortsetzen', resumeDrop: 'Verwerfen', name: 'Asset-Name', titleField: 'Titel', tagline: 'Kurzvorstellung in einer Zeile', description: 'Beschreibung',
  tags: 'Schlagwörter (durch Kommas getrennt, höchstens 3)', genre: 'Genre', price: 'Preis (RVN, leer = kostenlos)', kind: 'Art', template: 'Gestaltung (Vorlage)', theme: 'Farbe',
  coverDrop: 'Titelbild hierher ziehen oder zum Auswählen klicken', trackOrder: 'Titelreihenfolge und Titelnamen', previewRange: 'Hörprobe (Sekunden)',
  up: 'Nach oben', down: 'Nach unten', pass: 'Bestanden', warn: 'Achtung', block: 'Gesperrt', free: 'Kostenlos', tracks: 'Titelliste', previewListen: 'Hörprobe',
  pages: '{n} Seiten', previewPages: 'Leseprobe mit {n} Seiten', quantity: '{n} Tickets', unverifiedBadge: 'Kaution · Nicht verifiziert', verifiedBadge: 'Verifiziert',
  unverifiedWarning: 'RavenVault hat diese Verkäuferin bzw. diesen Verkäufer nicht überprüft. Für Erstattungen, Lieferung und Einlass ist die verkaufende Person verantwortlich.',
  officialWarning: 'Kein offizielles Produkt.', similarWarning: 'Es gibt ähnliche Namen: {names}', testOnly: 'Testphase – die echte Ausgabe im Mainnet ist ausgeschaltet.',
  format_single: 'Single', format_ep: 'EP', format_album: 'Album', kind_game: 'Spiel', kind_music: 'Musik', kind_book: 'Buch', kind_ticket: 'Ticket',
  kind_digital: 'Bilder- und Dateisammlung', kind_shop: 'Laden', menu: 'Speisekarte',
};

const ru: Record<CopyKey, string> = {
  title: 'Продать свою работу', emptyTitle: 'Перетащите сюда, чтобы создать товар', emptySay: 'Перетащите музыку, книгу, папку с игрой или изображения в любое место этого окна.',
  pick: 'Выбрать файлы', pickFolder: 'Выбрать папку', pasteLabel: 'Вставить адрес IPFS', pastePlaceholder: 'ipfs://Qm…', pasteGo: 'Загрузить',
  overlay: 'Перетащите сюда, чтобы создать товар', overlaySay: 'Просто отпустите. Тип, название и обложка заполнятся автоматически.',
  detecting: 'Определяем, что это…', ask: 'Всего один вопрос', previewHead: 'Так это увидят покупатели', checks: 'Автоматические проверки',
  costLine: 'Один раз при выпуске: залог (сжечь) {burn} RVN + комиссия сети около {net} RVN · При продаже: комиссия площадки {fee} % ({feeSource})',
  costLineFree: 'Один раз при выпуске: залог (сжечь) {burn} RVN + комиссия сети около {net} RVN · Бесплатный товар — без комиссии с продаж',
  publish: 'Опубликовать', publishing: 'Публикация…', advanced: 'Дополнительно', detail: 'Пошагово', startOver: 'Продать что-то другое', close: 'Закрыть',
  confirmTitle: 'Публикацию невозможно отменить', confirmGo: 'Опубликовать сейчас', confirmCancel: 'Отмена', doneTitle: 'Опубликовано',
  doneSay: 'Найдите товар на торговой площадке по названию «{name}».', blockedTitle: 'Опубликовать пока нельзя', resumeSay: 'Вы не закончили «{title}».',
  resumeGo: 'Продолжить', resumeDrop: 'Удалить', name: 'Название актива', titleField: 'Заголовок', tagline: 'Короткое описание в одну строку', description: 'Описание',
  tags: 'Метки (через запятую, не больше 3)', genre: 'Жанр', price: 'Цена (RVN, пусто = бесплатно)', kind: 'Тип', template: 'Оформление (шаблон)', theme: 'Цвет',
  coverDrop: 'Перетащите сюда обложку или нажмите, чтобы выбрать', trackOrder: 'Порядок и названия треков', previewRange: 'Фрагмент для прослушивания (секунды)',
  up: 'Выше', down: 'Ниже', pass: 'Пройдено', warn: 'Внимание', block: 'Заблокировано', free: 'Бесплатно', tracks: 'Список треков', previewListen: 'Прослушать',
  pages: '{n} стр.', previewPages: 'Ознакомительный фрагмент: {n} стр.', quantity: '{n} билетов', unverifiedBadge: 'Залог · Не проверено', verifiedBadge: 'Проверено',
  unverifiedWarning: 'RavenVault не проверял этого продавца. За возврат денег, доставку и вход отвечает продавец.',
  officialWarning: 'Это не официальный товар.', similarWarning: 'Есть похожие названия: {names}', testOnly: 'Тестовый этап — настоящий выпуск в основной сети выключен.',
  format_single: 'Сингл', format_ep: 'EP', format_album: 'Альбом', kind_game: 'Игра', kind_music: 'Музыка', kind_book: 'Книга', kind_ticket: 'Билет',
  kind_digital: 'Подборка изображений и файлов', kind_shop: 'Магазин', menu: 'Меню',
};

export const DROP_COPY: Readonly<Record<DropLang, Record<CopyKey, string>>> = Object.freeze({ ko, en, de, ru });

/** 문구 하나. {name} 자리는 vars 로 채운다(값은 글자로만 들어간다 — 화면은 textContent 로만 그린다). */
export function copy(lang: DropLang, key: CopyKey, vars: Record<string, string | number> = {}, fallback?: (ko: string) => string): string {
  const table = DROP_COPY[lang] ?? null;
  const raw = table ? table[key] : (fallback ? fallback(ko[key]) : ko[key]);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
export const isDropLang = (x: unknown): x is DropLang => typeof x === 'string' && (DROP_LANGS as readonly string[]).includes(x);

/**
 * 의사 현지화(레이아웃 시험용): 문구를 factor 배(1.6 = +60%, 2 = +100%) 길이로 늘린다. 띄어 쓴 낱말과 독일어식 긴 합성어를 섞어
 * 줄바꿈·잘림·겹침을 드러나게 한다. 화면은 시험(옵션 stretch)에서만 쓴다.
 */
export function stretchText(s: string, factor: number): string {
  if (!(factor > 1) || !s) return s;
  const need = Math.ceil(s.length * (factor - 1));
  const words = ['Ŵéïţ', 'Ľäñğ', 'Überschriftenzeilenlänge', 'Ъёжик', 'Ĥöçĥ', 'Длинноесловоприпроверке'];
  let pad = '';
  for (let i = 0; pad.length < need; i++) pad += (pad ? ' ' : '') + words[i % words.length];
  return `${s} ⟦${pad.slice(0, Math.max(need, 1))}⟧`;
}
