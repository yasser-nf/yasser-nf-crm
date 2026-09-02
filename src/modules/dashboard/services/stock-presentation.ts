import type { StockSummary } from "./dashboard.service";
import type { Result } from "@/types/result";

/**
 * What the stock widget should show for a given result.
 *
 * Pure, and separated from the page, because the distinction it draws is the
 * one the page got wrong: "you may not see this" and "we could not read this"
 * are different answers with different remedies, and collapsing them told a
 * Super Admin their role had lost access during what was really a database
 * outage. A rule that subtle should be assertable without rendering a route.
 */
export type StockPresentation =
  | { kind: "ready"; stock: StockSummary }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export function presentStock(result: Result<StockSummary>): StockPresentation {
  if (result.ok) {
    return { kind: "ready", stock: result.value };
  }

  /*
   * FORBIDDEN is the only code that means forbidden. Every other failure —
   * a dropped connection, an exhausted pool, a timeout — is reported as the
   * error it is, so the message points at the real problem.
   */
  if (result.error.code === "FORBIDDEN") {
    return { kind: "forbidden" };
  }

  return { kind: "error", message: result.error.userMessage };
}
