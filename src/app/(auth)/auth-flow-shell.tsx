import Link from "next/link";

import { APP_NAME } from "@/config/constants";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";

/**
 * The frame the invitation pages share with the login page.
 *
 * Same centred card, same radial wash, so somebody arriving from an email lands
 * somewhere that plainly belongs to this CRM rather than on a bare error.
 */
export function AuthFlowShell({
  title,
  description,
  tone = "default",
  action,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly tone?: "default" | "error";
  readonly action?: { readonly href: string; readonly label: string };
  readonly children?: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-primary-subtle),transparent_70%)]"
      />

      <div className="relative w-full max-w-[420px]">
        <div className="mb-8 flex flex-col gap-2 text-center">
          <p className="text-caption text-foreground-subtle">{APP_NAME}</p>
          <h1
            className={cn("text-page-title", tone === "error" ? "text-danger" : "text-foreground")}
          >
            {title}
          </h1>
          {description ? (
            <p className="text-description text-foreground-muted">{description}</p>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-raised sm:p-8">
          {children}

          {action ? (
            <Button asChild variant={children ? "ghost" : "default"} className="w-full">
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : null}
        </div>

        <p className="mt-6 text-center text-caption text-foreground-subtle">
          Private internal system. Authorised access only.
        </p>
      </div>
    </main>
  );
}
