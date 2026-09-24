# 증명서 글꼴 (인쇄·미리보기 전용)

증서가 어느 컴퓨터(맥·윈도우·리눅스)에서도 같은 모양으로 인쇄되도록 앱에 넣은 글꼴이다.
인터넷에서 받지 않는다 — `certificate.rs` 가 `include_bytes!` 로 굽고, 인쇄 파일에는 data: 로 넣는다.

| 파일 | 원본 | 바꾼 것 |
|---|---|---|
| `RVCertSerif-Regular/Bold/ExtraBold.woff2` | 나눔명조 Regular/Bold/ExtraBold (Copyright (c) 2010 NHN Corporation, SIL OFL 1.1, google/fonts `ofl/nanummyeongjo`) | 한글 음절 11,172자·한글 자모·로마자·문장부호만 남김(한자 뺌 — 한자는 시스템 글꼴로 대체), woff2 로 압축. **OFL 3항(예약 글꼴 이름)에 따라 글꼴 이름을 「RV Cert Serif」로 바꿈** — 수정본이라 원래 이름을 쓰지 않는다 |
| `CormorantGaramond.woff2`, `CormorantGaramond-Italic.woff2` | Cormorant Garamond (Copyright 2015 the Cormorant Project Authors, SIL OFL 1.1, 예약 이름 없음) | 로마자·문장부호만 남김, 굵기 축(wght 300–700) 유지 |

라이선스 원문: `OFL-RVCertSerif.txt`, `OFL-CormorantGaramond.txt`. 이 글꼴은 따로 팔 수 없다(OFL 1항).
만든 방법: fonttools `pyftsubset --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize`,
한글 범위 `U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203B,U+2160-216B,U+2190-2193,U+2460-2473,U+25A0-25CF,U+3000-303F,U+3131-318E,U+3200-321E,U+3260-327F,U+AC00-D7A3,U+FF01-FF60`.
