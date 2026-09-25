import { redirect } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { NotificationCenter } from "@/modules/notifications";
import { GlobalSearch } from "@/modules/search";
import { AppShell } from "@/shared/layouts/app-shell";

/**
 * Authenticated layout.
 *
 * Middleware already turns guests away, so this is a second check rather than
 * the only one. 02_ARCHITECTURE.md calls for validating twice: middleware can be
 * bypassed by a matcher change or a future route that falls outside it, and a
 * layout that assumes a user exists would then render the shell to a stranger.
 */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect(ROUTES.LOGIN);
  }

  return (
    <AppShell search={<GlobalSearch />} notifications={<NotificationCenter />}>
      {children}
    </AppShell>
  );
}
