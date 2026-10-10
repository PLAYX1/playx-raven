import type { ContentType } from '../core/creator/limits';
import { parseTags, safeText } from './drop-look';

/*
 * 장르 — 이름(RV.<종류>.<이름>)에는 넣지 않고, 서명된 매니페스트(v3)의 genre 칸에 둔다(대표 요청 2026-10-11).
 *   genre = { main: 종류별 고정 목록의 id | null, tags: 자유 태그 최대 3개 }
 * 장터는 main 으로 장르 필터·둘러보기, tags 로 검색을 한다. 이름에 넣지 않는 이유: 이름은 영구라 장르를 바꿀 수 없게 되고,
 * 30자 한도를 먹고, 장르 목록이 바뀌면 옛 이름이 틀린 말이 된다.
 *
 * 고정 목록은 이 표 한 곳. id 는 영구(장터 필터 키)라 바꾸지 않고, 보이는 말(ko·en)만 고친다. 새 장르는 끝에 더한다.
 * 'video' 는 영상 종류 제안(RV.V. — 대표 확인 대기, docs/design/drop-publish.md §14) 을 위한 자리다.
 *
 * 라비 추천: suggestGenre 는 제목·설명·파일 이름의 낱말로 「제안」만 한다(이유 한 줄 포함). 화면은 「라비 추천: ○○」 단추로
 * 보여 주고 사람이 눌러야 적용한다(제안 → 확인). 라비 AI 가 붙으면 같은 모양(GenreSuggestion)으로 돌려주면 된다.
 */

export type GenreKind = ContentType | 'video';
export type Genre = { id: string; ko: string; en: string; words: readonly string[] };
const g = (id: string, ko: string, en: string, ...words: string[]): Genre => ({ id, ko, en, words });

export const GENRES: Readonly<Record<GenreKind, readonly Genre[]>> = Object.freeze({
  music: [g('pop', '팝', 'Pop', 'pop', '팝'), g('hiphop', '힙합', 'Hip-hop', 'hiphop', 'hip-hop', 'rap', 'trap', '힙합', '랩'), g('rnb', 'R&B', 'R&B', 'rnb', 'r&b', 'soul', '소울'),
    g('rock', '록', 'Rock', 'rock', 'band', '록', '밴드'), g('ballad', '발라드', 'Ballad', 'ballad', '발라드'), g('electronic', '일렉트로닉', 'Electronic', 'edm', 'house', 'techno', 'electronic', '일렉'),
    g('jazz', '재즈', 'Jazz', 'jazz', '재즈'), g('classical', '클래식', 'Classical', 'classical', 'sonata', 'symphony', 'piano', '클래식', '소나타', '교향곡'),
    g('ccm', 'CCM·찬양', 'CCM / Worship', 'ccm', 'worship', 'praise', 'hymn', 'gospel', '찬양', '찬송', '워십', '예배'), g('folk', '포크·어쿠스틱', 'Folk / Acoustic', 'folk', 'acoustic', '어쿠스틱', '포크'),
    g('ost', 'OST', 'Soundtrack', 'ost', 'soundtrack', 'bgm', '배경음악'), g('kids', '동요', 'Kids', 'kids', 'nursery', '동요', '어린이'), g('other', '그 밖의 음악', 'Other', '')],
  game: [g('action', '액션', 'Action', 'action', 'shooter', 'fight', '액션', '슈팅', '격투'), g('puzzle', '퍼즐', 'Puzzle', 'puzzle', 'match', '퍼즐'), g('raising', '육성', 'Raising / Sim', 'raise', 'pet', 'farm', 'sim', '육성', '키우기', '농장'),
    g('rpg', 'RPG', 'RPG', 'rpg', 'quest', 'dungeon', '던전', '모험'), g('strategy', '전략', 'Strategy', 'strategy', 'tower', 'defense', '전략', '디펜스'), g('casual', '캐주얼', 'Casual', 'casual', 'idle', 'clicker', '캐주얼'),
    g('sports', '스포츠', 'Sports', 'sports', 'soccer', 'basketball', 'jiu', '스포츠', '축구', '농구', '주짓수'), g('rhythm', '리듬', 'Rhythm', 'rhythm', 'beat', '리듬'), g('edu', '교육', 'Educational', 'edu', 'quiz', 'learn', '교육', '퀴즈', '학습'), g('other', '그 밖의 게임', 'Other', '')],
  book: [g('novel', '소설', 'Fiction', 'novel', 'story', '소설', '이야기'), g('essay', '에세이', 'Essay', 'essay', '에세이', '수필'), g('poetry', '시', 'Poetry', 'poem', 'poetry', '시집'),
    g('faith', '신앙', 'Faith', 'bible', 'faith', 'prayer', '성경', '신앙', '기도', '묵상'), g('kids', '어린이', 'Children', 'kids', 'children', '동화', '어린이', '그림책'), g('comics', '만화', 'Comics', 'comic', 'manga', 'webtoon', '만화', '웹툰'),
    g('study', '학습', 'Study', 'study', 'textbook', 'workbook', '교재', '문제집', '학습', '교본'), g('selfhelp', '자기계발', 'Self-help', 'habit', 'success', '자기계발', '습관'), g('howto', '실용', 'How-to', 'guide', 'howto', 'recipe', '안내서', '요리', '실용'), g('other', '그 밖의 책', 'Other', '')],
  ticket: [g('concert', '공연', 'Concert / Show', 'concert', 'live', 'show', 'gig', '공연', '콘서트', '라이브'), g('talk', '강연', 'Talk', 'talk', 'lecture', 'seminar', '강연', '세미나', '특강'),
    g('meetup', '모임', 'Meetup', 'meetup', 'party', 'gathering', '모임', '파티', '번개'), g('class', '수업', 'Class', 'class', 'lesson', 'workshop', '수업', '레슨', '클래스', '워크숍'),
    g('match', '경기', 'Match', 'match', 'tournament', 'game', '경기', '대회', '시합'), g('exhibition', '전시', 'Exhibition', 'exhibition', 'gallery', '전시'), g('other', '그 밖의 행사', 'Other', '')],
  digital: [g('illustration', '그림', 'Illustration', 'illust', 'drawing', 'art', '그림', '일러스트'), g('photo', '사진', 'Photo', 'photo', 'jpg', '사진'), g('wallpaper', '배경화면', 'Wallpaper', 'wallpaper', '배경화면'),
    g('template', '서식', 'Template', 'template', 'form', '서식', '양식', '템플릿'), g('sound', '소리', 'Sound', 'sfx', 'sound', 'sample', '효과음', '소리'), g('document', '문서', 'Document', 'doc', 'pdf', 'txt', '문서', '자료'), g('other', '그 밖의 파일', 'Other', '')],
  video: [g('lecture', '강의', 'Lecture', 'lecture', 'course', 'class', '강의', '강좌'), g('workout', '운동', 'Workout', 'workout', 'fitness', 'yoga', 'bjj', '운동', '홈트', '요가', '주짓수'),
    g('film', '영화·단편', 'Film / Short', 'film', 'movie', 'short', '영화', '단편'), g('docu', '다큐', 'Documentary', 'documentary', 'docu', '다큐'), g('kids', '어린이', 'Kids', 'kids', 'children', '어린이', '키즈'),
    g('music-video', '뮤직비디오', 'Music video', 'mv', 'music video', '뮤비', '뮤직비디오'), g('other', '그 밖의 영상', 'Other', '')],
});
export const GENRE_TAGS_MAX = 3;
export type GenreValue = { main: string | null; tags: string[] };
export const genresFor = (k: GenreKind) => GENRES[k];
export const genreLabel = (k: GenreKind, id: string | null, lang: 'ko' | 'en' = 'ko') => GENRES[k].find(x => x.id === id)?.[lang] ?? '';

export class GenreError extends Error { constructor(readonly detail: string) { super('genre: ' + detail); this.name = 'GenreError'; } }
/** 매니페스트 genre 칸 엄격 검사(모르는 칸·목록에 없는 id·태그 4개 이상·제어/양방향 문자 거절). */
export function validateGenre(raw: unknown, kind: GenreKind): GenreValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join() !== 'main,tags') throw new GenreError('keys');
  const o = raw as Record<string, unknown>;
  if (o.main !== null && !GENRES[kind].some(x => x.id === o.main)) throw new GenreError('main');
  if (!Array.isArray(o.tags) || o.tags.length > GENRE_TAGS_MAX || !o.tags.every(t => safeText(t, 1, 20) && t.trim() === t && !/[,#<>]/.test(t))) throw new GenreError('tags');
  if (new Set((o.tags as string[]).map(t => t.toLowerCase())).size !== o.tags.length) throw new GenreError('tags-duplicate');
  return { main: o.main as string | null, tags: [...o.tags as string[]] };
}

export type GenreSuggestion = { id: string; label: string; why: string } | null;
/** 라비 추천(낱말 기반 제안). 확신이 없으면 null — 아무것도 고르지 않는다. */
export function suggestGenre(kind: GenreKind, text: { title?: string; description?: string; files?: readonly string[] }): GenreSuggestion {
  const hay = [text.title ?? '', text.description ?? '', ...(text.files ?? [])].join(' ').toLowerCase();
  let best: { genre: Genre; word: string; score: number } | null = null;
  for (const genre of GENRES[kind]) for (const w of genre.words) {
    if (!w) continue;
    const ascii = /^[a-z0-9&+ -]+$/.test(w);
    const hit = ascii ? new RegExp(`(^|[^a-z0-9])${w.replace(/[&+]/g, '\\$&')}([^a-z0-9]|$)`).test(hay) : hay.includes(w);
    if (hit && (!best || w.length > best.score)) best = { genre, word: w, score: w.length };
  }
  return best ? { id: best.genre.id, label: best.genre.ko, why: `「${best.word}」이(가) 보여서요` } : null;
}

/** 사람이 적은 태그 한 줄 → 장르 태그(3개까지). */
export const parseGenreTags = (line: string) => parseTags(line).slice(0, GENRE_TAGS_MAX);
