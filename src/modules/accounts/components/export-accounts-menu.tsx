"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { timestampedFilename } from "@/lib/csv";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { downloadCsv } from "@/utils/download";
import { exportAccountsAction } from "../actions/account.actions";
import { useAccountSelection } from "./account-selection-context";

/**
 * Export accounts as CSV.
 *
 * The three scopes differ only in what the server is asked for. None of the
 * filtering happens here: the current query string is handed over and re-parsed
 * server-side, and the selected ids are intersected there with the same
 * filtered result the operator is looking at. A client that lied about either
 * would get back exactly what it was already allowed to see.
 */
export function ExportAccountsMenu() {
  const searchParams = useSearchParams();
  const { selection } = useAccountSelection();
  const [exporting, setExporting] = useState(false);

  const selectedCount = selection.size;

  async function run(scope: "all" | "filtered" | "selected") {
    /* The disabled trigger is the real guard; this catches a keyboard repeat. */
    if (exporting) {
      return;
    }

    setExporting(true);

    try {
      const params = Object.fromEntries(searchParams.entries());
      const result = await exportAccountsAction(scope, params, [...selection]);

      if (!result.ok) {
        throw new ActionError(result.message, result.code);
      }

      if (result.data.rowCount === 0) {
        /*
         * Not an error, and deliberately not a downloaded file either. Saving a
         * CSV containing only headers looks like a broken export; saying so is
         * the more useful answer.
         */
        toast.info("No data to export", {
          description: "Nothing matches what you have selected or filtered.",
        });
        return;
      }

      downloadCsv(result.data.csv, timestampedFilename("accounts"));

      toast.success(
        `Exported ${result.data.rowCount} account${result.data.rowCount === 1 ? "" : "s"}`,
      );
    } catch (error) {
      toast.error("Could not export accounts", {
        description:
          error instanceof ActionError
            ? error.userMessage
            : "Something went wrong. Please try again.",
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="gap-2"
          disabled={exporting}
          aria-busy={exporting || undefined}
        >
          <Download className="size-4" aria-hidden="true" />
          {exporting ? "Exporting" : "Export"}
        </Button>
      </DropdownMenuTrigger>

      {/* Right-aligned so it opens inward on a phone rather than off the edge. */}
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => void run("all")}>Export all accounts</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("filtered")}>
          Export filtered accounts
        </DropdownMenuItem>
        <DropdownMenuItem
          /*
           * Disabled rather than hidden. A menu whose items move between
           * openings is harder to use than one where an option explains why it
           * is unavailable by being greyed out next to a count of zero.
           */
          disabled={selectedCount === 0}
          onSelect={() => void run("selected")}
        >
          Export selected accounts
          {selectedCount > 0 ? (
            <span className="ml-auto text-caption text-foreground-subtle">{selectedCount}</span>
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
