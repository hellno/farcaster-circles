import type { SpamSignals } from "../types";

// ---------- gate policy ----------

export type GatePolicy =
  | "off"
  | "powerBadge"
  | "mutual"
  | "powerBadgeOrMutual"
  | "powerBadgeAndMutual";

/**
 * Evaluate a gate policy against a user's signals. Returns whether onboarding is
 * allowed plus a human reason. `null` signals are treated as "not satisfied" for
 * that condition (fail-closed on the specific check), EXCEPT policy "off" which
 * always allows.
 */
export function evaluateGate(
  policy: GatePolicy,
  signals: SpamSignals,
): { allowed: boolean; reason: string } {
  // Operator + allowlisted fids always pass, whatever the policy.
  if (signals.isOperator) return { allowed: true, reason: "operator" };
  if (signals.allowlisted) return { allowed: true, reason: "allowlisted fid" };

  const pb = signals.powerBadge === true;
  const mut = signals.mutualWithOperator === true;

  switch (policy) {
    case "off":
      return { allowed: true, reason: "gate off" };
    case "powerBadge":
      return pb
        ? { allowed: true, reason: "has power badge" }
        : { allowed: false, reason: "no power badge" };
    case "mutual":
      return mut
        ? { allowed: true, reason: "mutual follow with operator" }
        : { allowed: false, reason: "not a mutual follow with operator" };
    case "powerBadgeOrMutual":
      return pb || mut
        ? {
            allowed: true,
            reason: pb ? "has power badge" : "mutual follow with operator",
          }
        : { allowed: false, reason: "no power badge and not a mutual follow" };
    case "powerBadgeAndMutual":
      return pb && mut
        ? { allowed: true, reason: "power badge AND mutual follow" }
        : {
            allowed: false,
            reason: `requires power badge (${pb}) AND mutual follow (${mut})`,
          };
    default:
      return { allowed: true, reason: "unknown policy — allowing" };
  }
}
