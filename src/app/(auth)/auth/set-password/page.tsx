import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SetPasswordForm } from "@/modules/auth";
import { configurationService } from "@/modules/settings";

import { AuthFlowShell } from "../../auth-flow-shell";

export const metadata: Metadata = {
  title: "Set your password",
};

/**
 * Where an invited person chooses their first password.
 *
 * Exempt from the proxy's redirects, not from authentication. The check is
 * right here: no session means whoever opened this URL never completed an
 * invitation, and they are sent to the login page rather than shown a form.
 *
 * The session is read with `getUser()`, which asks Supabase to verify the token,
 * rather than `getSession()`, which would believe a cookie. This page decides
 * whether to render a password field, so it should not trust a value the
 * browser could have written.
 *
 * Nothing about the person is displayed beyond the address the invitation was
 * sent to — no role, no permissions, no CRM data. There is nothing here for an
 * uninvited visitor to learn.
 */
export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect(ROUTES.LOGIN);
  }

  /* The same configured policy the Security page edits and the service enforces. */
  const security = await configurationService.security();

  return (
    <AuthFlowShell
      title="Welcome to the CRM"
      description={`You have been invited as ${data.user.email}. Choose a password to finish setting up your account.`}
    >
      <SetPasswordForm passwordMinLength={security.passwordMinLength} />
    </AuthFlowShell>
  );
}
