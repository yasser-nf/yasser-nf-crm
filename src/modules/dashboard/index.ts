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
export type { DashboardData, StockEntry, StockSummary } from "./services/dashboard.service";
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
