import { isLegacyAssetName } from '../brand/legacy-asset';
import { CreatorError } from './manifest';
import { assembleManifest, baseChecks } from './manifest-assemble';
import type { MessageSigner, PinAdapter, PinCache, PublishInput, PublishProgress, PublishResult } from './publish';

/*
 * 🔴 시험 전용 — 앱 코드는 import 하지 않는다(publish-route.test.ts 가 *.test.ts 밖의 import 를 잡는다).
 *
 * 이미 세상에 있는 옛 `RV.` 자산의 매니페스트를 시험 안에서 다시 만들어, **읽기 경로**(verifyManifest·목록·구매 판정·열람)를 시험하려고 둔다.
 * 새 발행 경로(publish.ts precheck/publishContent/planIssue)는 옛 이름을 계속 막고 우회 칸이 없다.
 * 이 함수는 옛 이름만 받는다(옛 이름이 아니면 거절) — 새 이름을 가드 없이 만드는 길로 쓰일 수 없다. 체인에는 아무것도 하지 않는다.
 */
export async function legacyManifestForTest(input: PublishInput, pin: PinAdapter, sign: MessageSigner,
  opts: { cache?: PinCache; onProgress?: (p: PublishProgress) => void } = {}): Promise<PublishResult> {
  if (!isLegacyAssetName(input.asset)) throw new CreatorError('manifest-files', 'legacy fixture: 옛 RV. 이름만 재현해요');
  const { check, problems } = baseChecks(input);
  if (problems.length) throw new CreatorError('manifest-files', problems.join(' / '));
  return assembleManifest(input, check, pin, sign, opts);
}
