import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * There is exactly one replacement path, and this is the test that says so.
 *
 * The Phase E audit found `replaceAllocationAction` still live on the account
 * detail page: a Server Action — a POST endpoint any session can call — that
 * committed a replacement with no bound replacement account and no M13 §8
 * password-change gate. The guarded path existed beside it, so "we always
 * preview first" was a convention, not a guarantee.
 *
 * The action, its hook, its service function and its input schema were deleted.
 * This test fails if any of them comes back, or if a second caller of the commit
 * transaction appears.
 *
 * It reads the source rather than importing it, deliberately. Importing proves
 * one module's shape; the risk here is a NEW file reintroducing the old symbol,
 * and only a scan of the whole tree can see that. It is also why this is a unit
 * test — no database, no environment, nothing that can be flaky.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }

    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      found.push(path);
    }
  }

  return found;
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

/**
 * Comments are stripped before matching.
 *
 * The removal is documented in prose at several call sites — explaining why the
 * old action is gone is exactly what a future reader needs — and a naive grep
 * would read those explanations as the symbol returning.
 */
function code(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

describe("the unguarded replacement path stays deleted", () => {
  it.each([
    "replaceAllocationAction",
    "useReplaceAllocation",
    "replaceAllocationSchema",
    "ReplaceAllocationInput",
  ])("has no live reference to %s", (symbol) => {
    const offenders = files.filter((file) => code(file.text).includes(symbol)).map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("exposes no service function that commits a replacement unguarded", () => {
    const offenders = files
      .filter((file) => /\breplaceAllocation\b\s*[,(:]/.test(code(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  /**
   * The commit transaction must stay private to its own module and keep exactly
   * one caller. Two callers is how the bypass existed in the first place.
   */
  it("keeps commitReplacement private, with confirmReplacement as its only caller", () => {
    const owner = files.find(
      (file) => file.path === "modules/quick-prepare/services/quick-prepare.service.ts",
    );

    expect(owner).toBeDefined();
    if (!owner) return;

    const body = code(owner.text);

    /* Never exported — not from the service object, not as a symbol. */
    expect(body).not.toMatch(/export\s+(async\s+)?function\s+commitReplacement/);
    expect(body).not.toMatch(/^\s*commitReplacement,\s*$/m);

    /* Declared once, called once. */
    const declarations = body.match(/async function commitReplacement\b/g) ?? [];
    const calls = body.match(/(?<!function )\bcommitReplacement\(/g) ?? [];

    expect(declarations).toHaveLength(1);
    expect(calls).toHaveLength(1);

    /* And no other file can reach it. */
    const elsewhere = files
      .filter((file) => file.path !== owner.path && code(file.text).includes("commitReplacement"))
      .map((file) => file.path);

    expect(elsewhere).toEqual([]);
  });

  it("leaves confirmReplacementAction as the only action that commits a replacement", () => {
    const actions = files.find(
      (file) => file.path === "modules/quick-prepare/actions/quick-prepare.actions.ts",
    );

    expect(actions).toBeDefined();
    if (!actions) return;

    const exported = [...code(actions.text).matchAll(/export async function (\w+)/g)].map(
      (match) => match[1],
    );

    /* Read-only lookups and the two Quick Prepare steps may remain. */
    expect(exported).toEqual([
      "previewAllocationAction",
      "confirmPreparationAction",
      "previewReplacementAction",
      "confirmReplacementAction",
    ]);
  });

  it("routes the account detail button through preview and confirm", () => {
    const button = files.find(
      (file) => file.path === "modules/quick-prepare/components/replace-account-button.tsx",
    );

    expect(button).toBeDefined();
    if (!button) return;

    const body = code(button.text);

    expect(body).toContain("usePreviewReplacement");
    expect(body).toContain("useConfirmReplacement");

    /* It must send the two fields that bind the commit to what was approved. */
    expect(body).toContain("replacementAccountId");
    expect(body).toContain("expectedProfileIds");
    expect(body).toContain("passwordChangeConfirmed");
  });
});
