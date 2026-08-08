import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

import { Button } from "@/shared/ui/button";

/**
 * Empty state.
 *
 * 04_UI_GUIDELINES.md requires every module to define an illustration, title,
 * description and primary action. Providing the shape here is what makes that
 * requirement cheap enough that no page skips it.
 */
export interface EmptyStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <div
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-lg bg-surface-raised"
      >
        <Icon className="size-5 text-foreground-subtle" />
      </div>

      <div className="flex max-w-sm flex-col gap-2">
        <h2 className="text-section-title text-foreground">{title}</h2>
        <p className="text-description text-foreground-muted">{description}</p>
      </div>

      {action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  );
}
