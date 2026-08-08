import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Next.js 16 generates AGENTS.md and CLAUDE.md on every dev start.
   *
   * CURRENT_MILESTONE.md and 05_DEVELOPMENT_WORKFLOW.md name the .ai directory
   * as the single source of truth. A second set of instruction files, rewritten
   * automatically and describing generic Next.js conventions, would compete with
   * it — and would win by being newer.
   */
  agentRules: false,
};

export default nextConfig;
