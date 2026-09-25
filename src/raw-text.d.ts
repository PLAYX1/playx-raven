/* Vite 의 `?raw` 가져오기 — 파일 글자를 그대로 문자열로(0.4.9 복구 단어 목록). */
declare module "*.txt?raw" {
  const text: string;
  export default text;
}
