/**
 * Idempotency module — public API (M08 jobs). docs/JOBS_MODULE.md §6.
 *
 * At-most-once business operations. The repository is NOT exported: receipts
 * are written only through `idempotency.begin` / `complete`, inside the
 * operation's own transaction, which is what makes them trustworthy.
 */
export {
  IdempotentReplay,
  idempotency,
  isReplay,
  requestHash,
  type Operation,
  type Receipt,
} from "./services/idempotency.service";
