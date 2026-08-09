import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { USER_ROLES } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { CustomerDetailView, customersService } from "@/modules/customers";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "Customer" };

/**
 * Customer details.
 *
 * `canAdminister` only decides what the UI offers. Blocking and archiving are
 * enforced in the service, so hiding the buttons is a convenience rather than
 * the control — a Server Action is an endpoint anyone with a session can call
 * directly.
 */
export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [detail, actor] = await Promise.all([customersService.getDetail(id), getCurrentUser()]);

  if (!detail.ok) {
    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={detail.error} title="Could not load this customer" />;
  }

  return (
    <CustomerDetailView
      detail={detail.value}
      canAdminister={actor?.role === USER_ROLES.SUPER_ADMIN}
    />
  );
}
