/*
 * 외부 주소 호스트 거르기 — photo.ts 에서 옮겼다(2026-10-14). 상품 문서의 판매자 파일 위치(core/creator/media-ref.ts)도 같은 함수를 쓰는데,
 * photo.ts 는 product-doc.ts 를 import 하므로 product-doc 쪽에서 photo.ts 를 부르면 서로 돈다. 이 파일은 아무것도 import 하지 않는다.
 * photo.ts 가 같은 이름으로 다시 내보낸다(기존 import 그대로 동작).
 */

/**
 * 아무 이름이나 IP 로 풀어 주는 공개 와일드카드 DNS(127.0.0.1.nip.io → 127.0.0.1 등). 이름만 보면 평범한 외부 주소지만 내부 IP 로 풀린다.
 * 알려진 것만 담았다(완전하지 않음) — 아래 주석대로 이 함수는 fetch 허가 판정이 아니다.
 */
export const WILDCARD_DNS_DOMAINS: readonly string[] = Object.freeze([
  'nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me', 'lacolhost.com', 'localhost.direct', 'fbi.com',
]);
/**
 * 이 호스트 이름을 서버가 가져가면 위험한가(IP 주소·localhost·내부 이름·비 ASCII·내부 IP 로 풀리는 이름). 안전하다고 판정하는 함수가 아니라 「거르는」 함수다.
 * 🔴 fetch 판정에 쓰지 않는다: 평범해 보이는 이름도 DNS 가 내부 IP 로 풀어 줄 수 있고(nip.io·sslip.io·localtest.me 같은 와일드카드,
 *    또는 공격자 소유 도메인의 DNS 재바인딩) 이름만으로는 막을 수 없다. 안전한 방법은 외부 URL 을 가져가지 않는 것뿐이다(assertUploadOnly).
 * 사진은 어차피 URL 로 가져오지 않는다. 이 함수는 연락처 url 칸과 서빙 주소 검사에서 이중으로 막는 용도다.
 */
export function isSsrfRiskyHost(hostname: string): boolean {
  const h = String(hostname).toLowerCase();
  if (!h || h.length > 253) return true;
  if (h.includes(':') || h.startsWith('[')) return true;                 // IPv6 및 포트 섞임
  if (!/^[a-z0-9.-]+$/.test(h)) return true;                              // 비 ASCII·특수문자(IDN 은 punycode 로 와야 하지만 보수적으로 거절)
  if (h.endsWith('.') || h.startsWith('.') || h.includes('..')) return true;
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/.test(h) || /^[0-9]+$/.test(h)) return true; // 10진/16진/점 IP
  if (!h.includes('.')) return true;                                      // 단일 라벨(내부 호스트)
  if (/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example)$/.test(h)) return true;
  if (WILDCARD_DNS_DOMAINS.some(d => h === d || h.endsWith('.' + d))) return true;   // 내부 IP 로 풀리는 공개 이름
  if (/(^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}([.-]|$)/.test(h)) return true; // 이름 속 IP(10-0-0-1.x, 169.254.169.254.x)
  return false;
}
