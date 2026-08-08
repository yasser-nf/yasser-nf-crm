import type { Metadata } from "next";
import { Suspense } from "react";

import { APP_NAME } from "@/config/constants";
import { LoginForm } from "@/modules/auth";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * Login page.
 *
 * 02_ARCHITECTURE.md: the app directory composes pages and holds no business
 * logic. The form, its validation and its service all belong to the auth module.
 */
export default function LoginPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      {/* Depth without heaviness. 04_UI_GUIDELINES.md: soft, never glowing. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-primary-subtle),transparent_70%)]"
      />

      <div className="relative w-full max-w-[420px]">
        <div className="mb-8 flex flex-col gap-2 text-center">
          <h1 className="text-page-title text-foreground">{APP_NAME}</h1>
          <p className="text-description text-foreground-muted">
            Sign in to continue to your workspace.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-raised sm:p-8">
          <Suspense fallback={<LoginFormSkeleton />}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-caption text-foreground-subtle">
          Private internal system. Authorised access only.
        </p>
      </div>
    </main>
  );
}

/**
 * 04_UI_GUIDELINES.md: use skeletons, never spinners, and never block the whole
 * page. This mirrors the form's real layout so nothing shifts when it arrives.
 */
function LoginFormSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-11 w-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
