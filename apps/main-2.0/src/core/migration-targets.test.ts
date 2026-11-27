import { expect, it } from "vitest";
import { assertMigrationTargetEnabled, enabledMigrationTargets, MIGRATION_TARGET_IDS, migrationTargetDescriptor } from "./migration-targets";

it("offers Antigravity CLI only when its own source is enabled", () => {
  expect(MIGRATION_TARGET_IDS).toContain("antigravity");
  expect(migrationTargetDescriptor("antigravity").source).toBe("antigravity-cli");
  expect(() => assertMigrationTargetEnabled("antigravity", {})).toThrow("disabled");
  expect(enabledMigrationTargets({ includeAntigravityCli: true })).toEqual([...enabledMigrationTargets({}), "antigravity"]);
});
