import { CircleCheck, History, Info, Lock, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { cn } from "@/utils/cn";
import type { SettingsChange } from "../repositories/settings.repository";
import type { SystemInformation } from "../services/system.service";
import { enforcementNote, type SettingDefinition } from "../services/settings-definitions";

/**
 * Read-only settings panels.
 *
 * Server Components — search results, the system page and the change history
 * hold no state, so none of them ship JavaScript.
 */

function formatDateTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Search results: which settings matched, and where to change them. */
export function SettingsSearchResults({
  matches,
  query,
}: {
  matches: readonly SettingDefinition[];
  query: string;
}) {
  if (!query.trim()) {
    return null;
  }

  if (matches.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
        No setting matches “{query}”.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-section-title text-foreground">
        {matches.length} setting{matches.length === 1 ? "" : "s"} matching “{query}”
      </h2>

      <ul className="flex flex-col gap-1.5">
        {matches.map((definition) => {
          const note = enforcementNote(definition);

          return (
            <li key={definition.key}>
              <Link
                href={`${ROUTES.SETTINGS}/${definition.category}`}
                className="flex flex-col gap-1 rounded-md bg-background-secondary px-4 py-3 transition-colors hover:bg-surface-raised"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-description text-foreground">{definition.label}</span>
                  <span className="rounded bg-surface-raised px-1.5 py-0.5 text-caption text-foreground-subtle">
                    {definition.category}
                  </span>
                  {note ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption",
                        definition.enforcement.state === "external"
                          ? "bg-primary-subtle text-primary"
                          : "bg-warning-subtle text-warning",
                      )}
                    >
                      {definition.enforcement.state === "external" ? (
                        <Lock className="size-3" aria-hidden="true" />
                      ) : (
                        <Info className="size-3" aria-hidden="true" />
                      )}
                      {definition.enforcement.state === "external" ? "External" : "Not enforced"}
                    </span>
                  ) : null}
                </span>
                <span className="text-caption text-foreground-subtle">
                  {definition.description}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** System information. Measured, never configured — which is why there is no form. */
export function SystemPanel({ information }: { information: SystemInformation }) {
  const { health } = information;

  const tone =
    health.level === "green"
      ? "border-success/30 bg-success-subtle text-success"
      : health.level === "yellow"
        ? "border-warning/30 bg-warning-subtle text-warning"
        : "border-danger/30 bg-danger-subtle text-danger";

  return (
    <div className="flex flex-col gap-6">
      <section className={cn("flex flex-col gap-2 rounded-lg border p-5", tone)}>
        <span className="flex items-center gap-2 text-card-title">
          {health.level === "green" ? (
            <CircleCheck className="size-4" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-4" aria-hidden="true" />
          )}
          System health
        </span>
        {health.findings.map((finding) => (
          <p key={finding.message} className="text-caption">
            {finding.message}
          </p>
        ))}
      </section>

      <section className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Application version" value={information.applicationVersion} />
        <Field label="Database" value={information.databaseVersion} />
        <Field label="Environment" value={information.environment} />
        <Field label="Last migration" value={information.lastMigration ?? "—"} />
        <Field label="Migration applied" value={formatDateTime(information.lastMigrationAt)} />
        <Field label="Migrations applied" value={String(information.migrationsApplied)} />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-card-title text-foreground">Storage</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Backup storage used" value={formatBytes(information.storage.backupBytes)} />
          <Field label="Backups stored" value={String(information.storage.backupCount)} />
          <Field
            label="Bucket"
            value={information.storage.bucketConfigured ? "Configured" : "Not configured"}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-card-title text-foreground">Scheduler</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Configured frequency" value={information.scheduler.frequency} />
          <Field
            label="Status"
            value={information.scheduler.enforced ? "Running" : "Not running"}
          />
        </div>
        <p className="flex items-start gap-2 rounded-md bg-background-secondary p-3 text-caption text-foreground-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {information.scheduler.note}
        </p>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span className="text-description text-foreground">{value}</span>
    </div>
  );
}

/**
 * Change history.
 *
 * Read from the audit log, which already records who, when, before and after
 * for every settings write. A second history table would record the same fact
 * twice and the two could disagree.
 */
export function SettingsHistory({ changes }: { changes: readonly SettingsChange[] }) {
  if (changes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-caption text-foreground-muted">
        No settings have been changed yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {changes.map((change) => (
        <li
          key={change.id}
          className="flex flex-col gap-2 rounded-md border border-border bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
            <span className="flex items-center gap-2 text-foreground">
              <History className="size-3.5 text-foreground-subtle" aria-hidden="true" />
              {change.actorName ?? "System"}
            </span>
            <span className="text-foreground-subtle">{formatDateTime(change.createdAt)}</span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <ValueBlock label="Before" value={change.before} tone="text-foreground-subtle" />
            <ValueBlock label="After" value={change.after} tone="text-foreground" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ValueBlock({ label, value, tone }: { label: string; value: unknown; tone: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <pre
        className={cn(
          "overflow-x-auto rounded bg-background-secondary p-2 font-mono text-caption",
          tone,
        )}
      >
        {JSON.stringify(value ?? {}, null, 2)}
      </pre>
    </div>
  );
}
