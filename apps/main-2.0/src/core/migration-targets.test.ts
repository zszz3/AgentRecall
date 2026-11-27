import { expect, it } from "vitest";
import { assertMigrationTargetEnabled, enabledMigrationTargets, MIGRATION_TARGET_IDS, migrationTargetDescriptor } from "./migration-targets";

it("offers Antigravity CLI only when its own source is enabled", () => {
  expect(MIGRATION_TARGET_IDS).toContain("antigravity");
  expect(migrationTargetDescriptor("antigravity").source).toBe("antigravity-cli");
  expect(() => assertMigrationTargetEnabled("antigravity", {})).toThrow("disabled");
  expect(enabledMigrationTargets({ includeAntigravityCli: true })).toEqual([...enabledMigrationTargets({}), "antigravity"]);
});

it("offers Oh My Pi as a migration target only when its source is enabled", () => {
  expect(MIGRATION_TARGET_IDS).toContain("omp");
  expect(migrationTargetDescriptor("omp")).toMatchObject({ source: "omp-cli", family: "omp" });
  expect(enabledMigrationTargets({})).not.toContain("omp");
  expect(enabledMigrationTargets({ includeOmp: true })).toContain("omp");
  expect(() => assertMigrationTargetEnabled("omp", {})).toThrow("Oh My Pi migration target is disabled in Settings.");
});
