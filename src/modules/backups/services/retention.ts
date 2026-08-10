/**
 * Retention policy.
 *
 * Pure: it decides what may be deleted, and deletes nothing itself. That split
 * is deliberate — a policy that both decides and acts cannot be tested without
 * risking real data, and this is the one part of the module whose bugs destroy
 * backups rather than merely failing to make them.
 */

export const DEFAULT_KEEP_LAST = 30;
export const MIN_KEEP_LAST = 1;
export const MAX_KEEP_LAST = 365;

export interface RetentionCandidate {
  readonly id: string;
  readonly createdAt: Date;
  readonly type: string;
  readonly isRestorePoint: boolean;
}

export interface RetentionPlan {
  readonly keep: readonly string[];
  readonly prune: readonly string[];
}

/**
 * Chooses which backups to keep.
 *
 * Two things are never pruned, regardless of age or count:
 *
 *   restore points  a deliberate marker someone set before a risky operation
 *   snapshots       the same intent, expressed as a type
 *
 * Both exist precisely because somebody expected to need them later, and a
 * count-based policy that discarded them would delete the most valuable backups
 * first. They are excluded from the count entirely rather than merely sorted
 * last, so a burst of snapshots cannot push out every routine backup either.
 */
export function planRetention(
  candidates: readonly RetentionCandidate[],
  keepLast: number,
): RetentionPlan {
  /*
   * NaN is checked before clamping, not after. Math.max(NaN, 1) is NaN, which
   * survives every comparison and turns slice(0, limit) into slice(0, NaN) —
   * keeping nothing and pruning every backup in the system. The clamp alone
   * looks sufficient and is not.
   */
  const requested = Math.trunc(keepLast);
  const safe = Number.isFinite(requested) ? requested : DEFAULT_KEEP_LAST;
  const limit = Math.min(Math.max(safe, MIN_KEEP_LAST), MAX_KEEP_LAST);

  const protectedIds: string[] = [];
  const prunable: RetentionCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.isRestorePoint || candidate.type === "snapshot") {
      protectedIds.push(candidate.id);
    } else {
      prunable.push(candidate);
    }
  }

  /* Newest first, so "keep the last N" means the N most recent. */
  const ordered = [...prunable].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    keep: [...protectedIds, ...ordered.slice(0, limit).map((entry) => entry.id)],
    prune: ordered.slice(limit).map((entry) => entry.id),
  };
}
