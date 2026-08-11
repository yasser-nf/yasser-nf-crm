"use client";

import { useMutation } from "@tanstack/react-query";
import { Info, LoaderCircle, Lock, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { cn } from "@/utils/cn";
import { updateSettingsAction, type ActionResult } from "../actions/settings.actions";
import {
  enforcementNote,
  type SettingDefinition,
  type SettingsCategory,
} from "../services/settings-definitions";
import type { ConfigurationIssue } from "../services/validation.service";

/**
 * One settings category, rendered from its definitions.
 *
 * The form is generated from the catalogue rather than hand-written per page.
 * That is what keeps a settings page free of business logic — it renders
 * whatever the catalogue declares and posts it back; every rule about what is
 * valid lives in the service.
 *
 * Values are read from the definition's dotted key, so the same component
 * serves general, company, security, backups and notifications without knowing
 * anything about any of them.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError(result.message, result.code, result.fieldErrors);
}

/** `general.timezone` on the definition is `timezone` inside its category. */
function fieldName(definition: SettingDefinition): string {
  const parts = definition.key.split(".");
  return parts.slice(1).join(".");
}

function readValue(values: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, values);
}

function writeValue(
  values: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (!head) return values;

  if (rest.length === 0) {
    return { ...values, [head]: value };
  }

  const nested =
    typeof values[head] === "object" && values[head] !== null
      ? (values[head] as Record<string, unknown>)
      : {};

  return { ...values, [head]: writeValue(nested, rest.join("."), value) };
}

export function SettingsForm({
  category,
  definitions,
  initialValues,
  issues,
  canEdit,
}: {
  category: SettingsCategory;
  definitions: readonly SettingDefinition[];
  initialValues: Record<string, unknown>;
  issues: readonly ConfigurationIssue[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: async () => unwrap(await updateSettingsAction(category, values)),
    onSuccess: () => {
      setFieldErrors({});
      toast.success("Settings saved");
      router.refresh();
    },
    onError: (error) => {
      if (error instanceof ActionError && error.fieldErrors) {
        setFieldErrors(error.fieldErrors);
      }
      toast.error("Could not save", { description: error.userMessage });
    },
  });

  const blocking = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  function issueFor(definition: SettingDefinition): ConfigurationIssue | undefined {
    return issues.find((issue) => issue.key === definition.key);
  }

  if (definitions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-description text-foreground-muted">
        Nothing in this category is available to your role.
      </p>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      noValidate
      className="flex flex-col gap-5"
    >
      {blocking.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-subtle p-4"
        >
          <span className="flex items-center gap-2 text-card-title text-foreground">
            <TriangleAlert className="size-4 text-danger" aria-hidden="true" />
            These settings conflict
          </span>
          {blocking.map((issue) => (
            <p key={issue.key} className="text-caption text-foreground-muted">
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-warning/30 bg-warning-subtle p-4">
          {warnings.map((issue) => (
            <p key={issue.key} className="text-caption text-foreground-muted">
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        {definitions.map((definition) => {
          const name = fieldName(definition);
          const value = readValue(values, name);
          const note = enforcementNote(definition);
          const issue = issueFor(definition);
          const error = fieldErrors[name];

          return (
            <div key={definition.key} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Label
                  htmlFor={definition.key}
                  className="text-description font-medium text-foreground"
                >
                  {definition.label}
                </Label>

                {/*
                  The enforcement badge is the honest part of this module: a
                  stored password policy that nothing enforces must never look
                  like an active control.
                */}
                {note ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption",
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
              </div>

              <p className="text-caption text-foreground-subtle">{definition.description}</p>

              {definition.type === "boolean" ? (
                <label className="flex w-fit items-center gap-2 text-caption text-foreground-muted">
                  <input
                    id={definition.key}
                    type="checkbox"
                    checked={value === true}
                    disabled={!canEdit || save.isPending}
                    onChange={(event) =>
                      setValues((current) => writeValue(current, name, event.target.checked))
                    }
                    className="size-4 rounded border-border"
                  />
                  {value === true ? "Enabled" : "Disabled"}
                </label>
              ) : definition.type === "select" ? (
                <select
                  id={definition.key}
                  value={typeof value === "string" ? value : ""}
                  disabled={!canEdit || save.isPending}
                  onChange={(event) =>
                    setValues((current) => writeValue(current, name, event.target.value))
                  }
                  className="h-11 rounded-md border border-border bg-surface px-3 text-description text-foreground"
                >
                  {definition.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={definition.key}
                  type={
                    definition.type === "number"
                      ? "number"
                      : definition.type === "email"
                        ? "email"
                        : definition.type === "url"
                          ? "url"
                          : "text"
                  }
                  value={value === null || value === undefined ? "" : String(value)}
                  min={definition.min}
                  max={definition.max}
                  disabled={!canEdit || save.isPending}
                  onChange={(event) =>
                    setValues((current) =>
                      writeValue(
                        current,
                        name,
                        definition.type === "number"
                          ? event.target.value === ""
                            ? ""
                            : Number(event.target.value)
                          : event.target.value,
                      ),
                    )
                  }
                  className="h-11 max-w-md"
                />
              )}

              {note ? <p className="text-caption text-foreground-subtle">{note}</p> : null}
              {issue ? (
                <p
                  className={cn(
                    "text-caption",
                    issue.severity === "error" ? "text-danger" : "text-warning",
                  )}
                >
                  {issue.message}
                </p>
              ) : null}
              {error ? <p className="text-caption text-danger">{error}</p> : null}
            </div>
          );
        })}
      </div>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending} className="min-w-32 gap-2">
            {save.isPending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Save changes
          </Button>
          <span className="text-caption text-foreground-subtle">
            Every change is recorded in the audit log.
          </span>
        </div>
      ) : (
        <p className="rounded-md bg-background-secondary px-4 py-3 text-caption text-foreground-muted">
          Read-only. Only a Super Admin can change settings.
        </p>
      )}
    </form>
  );
}
