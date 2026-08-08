/**
 * Database schema.
 *
 * Deliberately empty.
 *
 * 03_DATABASE.md — which 05_DEVELOPMENT_WORKFLOW.md ranks fourth in the source
 * of truth order — has no content yet. Defining tables here would mean
 * inventing the data model, which 01_MASTER_RULES.md forbids: "Never guess
 * requirements."
 *
 * Milestone M01 is the foundation only. Tables arrive with the milestone that
 * owns them, once the database document defines them.
 *
 * Every table module gets re-exported from this barrel so that drizzle-kit and
 * the Database Adapter both see one schema surface.
 */

export {};
