import { MobileNavigation } from "./mobile-navigation";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * Application shell.
 *
 * Desktop first with a fixed sidebar; mobile falls back to bottom navigation.
 * 04_UI_GUIDELINES.md forbids horizontal scrolling, which is why the content
 * column is `min-w-0` — without it a wide table would push the whole layout
 * sideways instead of scrolling within its own container.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />

        <main className="flex-1 p-4 lg:p-6">{children}</main>

        <MobileNavigation />
      </div>
    </div>
  );
}
