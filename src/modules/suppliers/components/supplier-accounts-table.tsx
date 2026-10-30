"use client";

import { Layers } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { EmptyState } from "@/shared/feedback/empty-state";
import type { SupplierOption } from "@/shared/forms/ownership-fields";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import type { SupplierAccountRow } from "../services/suppliers.service";
import { AssignSupplierButton } from "./assign-supplier-dialog";

/**
 * The accounts one supplier provided (M09B).
 *
 * `hasProblem` comes from the shared `accountHasNoBlockingProblemSql`
 * predicate — the same definition of "has a problem" the Accounts list and the
 * dashboard use — so the figure on the supplier row and the flags in this
 * table cannot disagree.
 *
 * Status is shown as stored rather than as an effective status, because the
 * problem flag beside it already carries what a derived badge would add, and
 * deriving it here would mean a second, separately-computed answer to the same
 * question.
 */
export function SupplierAccountsTable({
  rows,
  total,
  limit,
  offset,
  suppliers,
  canManage,
}: {
  readonly rows: readonly SupplierAccountRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly suppliers: readonly SupplierOption[];
  readonly canManage: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const problemsOnly = searchParams.get("problems") === "1";

  function hrefWith(changes: Record<string, string | null>): string {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }

    return `${pathname}?${params.toString()}`;
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-section-title text-foreground">Accounts from this supplier</h2>

        <Button
          variant={problemsOnly ? "default" : "outline"}
          size="sm"
          onClick={() =>
            router.push(hrefWith({ problems: problemsOnly ? null : "1", offset: "0" }))
          }
        >
          {problemsOnly ? "Showing problems only" : "Problems only"}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={problemsOnly ? "No problem accounts" : "No accounts yet"}
          description={
            problemsOnly
              ? "Nothing from this supplier currently has a blocking problem."
              : "Mark an account as supplied and choose this supplier to link it here."
          }
          {...(problemsOnly
            ? {
                action: {
                  label: "Show all accounts",
                  onClick: () => router.push(hrefWith({ problems: null, offset: "0" })),
                },
              }
            : {})}
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-surface">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ account, hasProblem }) => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <Link
                        href={`${ROUTES.ACCOUNTS}/${account.id}`}
                        className="font-mono text-foreground hover:underline"
                      >
                        {account.email}
                      </Link>
                    </TableCell>
                    <TableCell className="text-foreground-muted">
                      {account.status.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-foreground-muted">
                      {account.country ?? "—"}
                    </TableCell>
                    <TableCell>
                      {hasProblem ? (
                        <Badge variant="destructive">Blocking</Badge>
                      ) : (
                        <span className="text-caption text-foreground-subtle">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <AssignSupplierButton
                          account={{
                            id: account.id,
                            email: account.email,
                            ownership: account.ownership,
                            supplierId: account.supplierId,
                          }}
                          suppliers={suppliers}
                          label="Reassign"
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-3 lg:hidden">
            {rows.map(({ account, hasProblem }) => (
              <li
                key={account.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`${ROUTES.ACCOUNTS}/${account.id}`}
                    className="font-mono text-caption text-foreground hover:underline"
                  >
                    {account.email}
                  </Link>
                  {hasProblem ? <Badge variant="destructive">Blocking</Badge> : null}
                </div>

                <p className="text-caption text-foreground-muted">
                  {account.status.replace(/_/g, " ")}
                  {account.country ? ` · ${account.country}` : ""}
                </p>

                {canManage ? (
                  <div className="flex justify-end">
                    <AssignSupplierButton
                      account={{
                        id: account.id,
                        email: account.email,
                        ownership: account.ownership,
                        supplierId: account.supplierId,
                      }}
                      suppliers={suppliers}
                      label="Reassign"
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <p className="text-caption text-foreground-subtle">
              {total} account{total === 1 ? "" : "s"} · page {page} of {pageCount}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() =>
                  router.push(hrefWith({ offset: String(Math.max(offset - limit, 0)) }))
                }
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + limit >= total}
                onClick={() => router.push(hrefWith({ offset: String(offset + limit) }))}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
