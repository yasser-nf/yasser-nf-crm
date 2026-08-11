/**
 * Overall system health.
 *
 * Pure — no database, no clock of its own. Takes measured facts and returns a
 * colour, so the rule is testable and lives in exactly one place.
 *
 * Never hardcoded, per the M09 brief: every input below is counted from the
 * live database. A green light here means the checks actually passed, not that
 * nobody wired up the red one.
 */

export type HealthLevel = "green" | "yellow" | "red";

/** Hours after which a backup stops counting as recent. */
export const BACKUP_STALE_HOURS = 48;
export const BACKUP_WARNING_HOURS = 24;

export interface HealthInputs {
  readonly criticalProblems: number;
  readonly failedBackups: number;
  readonly lastBackupAt: Date | null;
  readonly lastChecksumVerified: boolean;
  /** False when a database read used by the dashboard failed outright. */
  readonly databaseReachable: boolean;
}

export interface HealthFinding {
  readonly level: HealthLevel;
  readonly message: string;
}

export interface HealthReport {
  readonly level: HealthLevel;
  readonly findings: readonly HealthFinding[];
}

function hoursSince(value: Date, now: Date): number {
  return (now.getTime() - value.getTime()) / 3_600_000;
}

/**
 * Reduces the findings to one colour.
 *
 * Worst wins. A green finding never offsets a red one — averaging severities
 * would let three healthy checks hide a failing backup, which is the opposite
 * of what a status light is for.
 */
function worst(findings: readonly HealthFinding[]): HealthLevel {
  if (findings.some((finding) => finding.level === "red")) return "red";
  if (findings.some((finding) => finding.level === "yellow")) return "yellow";
  return "green";
}

export function assessHealth(inputs: HealthInputs, now: Date): HealthReport {
  const findings: HealthFinding[] = [];

  if (!inputs.databaseReachable) {
    /* Nothing else can be trusted if the reads themselves failed. */
    return {
      level: "red",
      findings: [{ level: "red", message: "The database could not be reached." }],
    };
  }

  if (inputs.criticalProblems > 0) {
    findings.push({
      level: "red",
      message: `${inputs.criticalProblems} critical problem${inputs.criticalProblems === 1 ? "" : "s"} open.`,
    });
  }

  if (inputs.failedBackups > 0) {
    findings.push({
      level: "yellow",
      message: `${inputs.failedBackups} backup${inputs.failedBackups === 1 ? "" : "s"} failed.`,
    });
  }

  if (!inputs.lastBackupAt) {
    findings.push({ level: "red", message: "No backup has ever completed." });
  } else {
    const age = hoursSince(inputs.lastBackupAt, now);

    if (age >= BACKUP_STALE_HOURS) {
      findings.push({
        level: "red",
        message: `The last backup is ${Math.floor(age / 24)} days old.`,
      });
    } else if (age >= BACKUP_WARNING_HOURS) {
      findings.push({
        level: "yellow",
        message: `The last backup is ${Math.floor(age)} hours old.`,
      });
    }

    if (!inputs.lastChecksumVerified) {
      /*
       * Yellow, not red: a completed-but-unverified backup probably exists and
       * probably works. "Probably" is exactly why it is not green.
       */
      findings.push({
        level: "yellow",
        message: "The most recent backup has not had its checksum verified.",
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ level: "green", message: "All checks passed." });
  }

  return { level: worst(findings), findings };
}
