/** Home shows evidence, never infers a good status from a missing RPC value. */
type Signal = { label: string; tone: "good" | "warn" | "bad" };
export function homeSafety(lock: any, survey: any, currentIssue = ""): { lock: Signal; backup: Signal } {
  const automatic = survey?.automatic;
  return {
    lock: !lock || typeof lock.encrypted !== "boolean" || (lock.encrypted && typeof lock.unlocked !== "boolean")
      ? { label: "잠금 미확인", tone: "warn" }
      : !lock.encrypted ? { label: "잠금 암호 없음", tone: "bad" }
      : lock.unlocked ? { label: "잠금 열려 있음", tone: "warn" }
      : { label: "잠금 켜짐", tone: "good" },
    // A verified local snapshot is not proof of an external or cloud backup.
    backup: currentIssue || automatic?.error || automatic?.warning
      ? { label: "백업 점검 필요", tone: "bad" }
      : automatic?.local_complete === true ? { label: "백업 로컬 확인", tone: "good" }
      : { label: "백업 확인 필요", tone: "warn" },
  };
}
