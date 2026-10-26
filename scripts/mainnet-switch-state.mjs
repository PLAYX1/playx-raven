// 스위치 한 곳(core/creator/mainnet-switch.json)의 지금 값. 시험은 「꺼짐」을 박지 않고 이 값에 연동한다 —
// 그래야 enable 커밋을 얹어도 같은 시험이 통과하고, 켜진 채 슬쩍 커밋되는 것은 별도 안전 시험이 막는다.
import { readFileSync } from 'node:fs';
export const SWITCH_PATH = new URL('../core/creator/mainnet-switch.json', import.meta.url);
export const SW = JSON.parse(readFileSync(SWITCH_PATH, 'utf8'));
