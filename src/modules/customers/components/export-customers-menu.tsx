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
import { exportCustomersAction } from "../actions/customer.actions";

/**
 * Export customers as CSV.
 *
 * The current query string is handed to the server and re-parsed there, so
 * "filtered" means Active only and Blocked exactly as the screen means them.
 */
export function ExportCustomersMenu() {
  const searchParams = useSearchParams();
  const [exporting, setExporting] = useState(false);

  async function run(scope: "all" | "filtered") {
    if (exporting) {
      return;
    }

    setExporting(true);

    try {
      const params = Object.fromEntries(searchParams.entries());
      const result = await exportCustomersAction(scope, params);

      if (!result.ok) {
        throw new ActionError(result.message, result.code);
      }

      if (result.data.rowCount === 0) {
        toast.info("No data to export", {
          description: "No customers match the current filters.",
        });
        return;
      }

      downloadCsv(result.data.csv, timestampedFilename("customers"));

      toast.success(
        `Exported ${result.data.rowCount} customer${result.data.rowCount === 1 ? "" : "s"}`,
      );
    } catch (error) {
      toast.error("Could not export customers", {
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

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => void run("all")}>Export all customers</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("filtered")}>
          Export filtered customers
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
