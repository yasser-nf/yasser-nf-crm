/**
 * Dashboard module — public API. ADR-003 Rule 2.
 *
 * Read-only. This module owns no data: every figure is aggregated from tables
 * other modules own, and everything with a rule attached — presence, allocation,
 * problem state — is borrowed through those modules' public APIs rather than
 * recomputed here.
 *
 * The repository is not exported. It can count every row in the system, and
 * exposing it would offer a way past the role check that decides which of those
 * counts a caller is allowed to see.
 */
export { dashboardService, LOW_STOCK_THRESHOLD } from "./services/dashboard.service";
export type {
  DashboardData,
  StockEntry,
  StockSummary,
  /* M10 §14. */
  SupplierOwnership,
} from "./services/dashboard.service";

/* M10. Pure and clock-injected, so a unit test can pin the date. */
export {
  tallySupplierOwnership,
  type OwnershipTally,
  type SupplierAccountInput,
  type SupplierOwnershipRow,
  type SupplierProfileInput,
} from "./services/supplier-ownership";

/* M10 §14. Ownership and per-supplier figures, in the existing widget vocabulary. */
export { OwnershipWidget, SuppliersWidget } from "./components/ownership-widgets";
export { presentStock, type StockPresentation } from "./services/stock-presentation";

export {
  assessHealth,
  BACKUP_STALE_HOURS,
  BACKUP_WARNING_HOURS,
  type HealthInputs,
  type HealthLevel,
  type HealthReport,
} from "./services/system-health";

export type {
  ActivityRow,
  BackupSummary,
  DashboardCounts,
  LabelledCount,
  SeriesPoint,
} from "./repositories/dashboard.repository";

export {
  BarChart,
  BreakdownBars,
  Metric,
  MetricGrid,
  Widget,
  WidgetEmpty,
  WidgetError,
  WidgetForbidden,
} from "./components/dashboard-primitives";

export {
  AccountsWidget,
  ActivityWidget,
  BackupWidget,
  ChartsWidget,
  CustomersWidget,
  ExpirationWidget,
  HealthWidget,
  OnlineUsersWidget,
  ProblemsCountsWidget,
  ProblemsListWidget,
  ProfilesWidget,
  QuickPrepareWidget,
  ReopenedWidget,
  RevenueWidget,
  StockWidget,
  UsersCountsWidget,
} from "./components/dashboard-widgets";
