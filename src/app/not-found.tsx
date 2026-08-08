import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { Button } from "@/shared/ui/button";

/**
 * 404 page.
 *
 * 04_UI_GUIDELINES.md requires a safe recovery path from every error, so this
 * offers a way back rather than a dead end.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-caption font-medium tracking-wide text-primary uppercase">404</p>
        <h1 className="text-page-title text-foreground">Page not found</h1>
        <p className="max-w-sm text-description text-foreground-muted">
          The page you are looking for does not exist or has been moved.
        </p>
      </div>

      <Button asChild>
        <Link href={ROUTES.DASHBOARD}>Back to dashboard</Link>
      </Button>
    </div>
  );
}
