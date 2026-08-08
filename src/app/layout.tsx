import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { APP_DESCRIPTION, APP_NAME } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { AppProviders } from "@/providers";

import "./globals.css";

/**
 * 04_UI_GUIDELINES.md: one font family, three weights — Regular, Medium, Bold.
 * No extra bold, no ultra light.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  // This is a private internal system. It must never appear in a search index.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: "#080c14",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Resolved on the server so the first paint already knows who is signed in.
   * Middleware has already refreshed the session by the time this runs.
   */
  const user = await getCurrentUser();

  return (
    <html lang="en" className={`${inter.variable} dark`} data-theme="dark" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <AppProviders initialUser={user}>{children}</AppProviders>
      </body>
    </html>
  );
}
