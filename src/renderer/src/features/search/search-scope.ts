export interface ResolvedSearchScope {
  environmentId: string | "all" | undefined;
  projectPath: string | undefined;
  projectEnvironmentConflict: boolean;
}

export function resolveSearchScope(
  environmentId: string | "all",
  projectPath: string | undefined,
  projectEnvironmentId: string | undefined,
): ResolvedSearchScope {
  const selectedProjectEnvironmentId = projectPath ? projectEnvironmentId : undefined;
  const explicitEnvironmentId = environmentId !== "all" ? environmentId : undefined;
  return {
    environmentId: explicitEnvironmentId ?? selectedProjectEnvironmentId,
    projectPath,
    projectEnvironmentConflict: Boolean(
      projectPath
        && explicitEnvironmentId
        && selectedProjectEnvironmentId
        && explicitEnvironmentId !== selectedProjectEnvironmentId,
    ),
  };
}
