import { useEffect, useState } from "react";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";

export interface TeamCatalogEntry {
  team: { id: string; name: string; repository: string };
  catalog: TeamCatalog;
}

export interface TeamCatalogs {
  /** Null while loading. */
  teams: TeamCatalogEntry[] | null;
  /** Teams whose catalog could not be read, with the reason. */
  problems: Array<{ team: string; message: string }>;
}

/**
 * Reads the catalog of every connected team for resource pages that only show team content;
 * editing and publishing stay in the team space. Nothing is read while teams are turned off.
 */
export function useTeamCatalogs(api: TeamWorkspaceApi, refreshKey: number, enabled = true): TeamCatalogs {
  const [state, setState] = useState<TeamCatalogs>({ teams: null, problems: [] });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState({ teams: null, problems: [] });
    void (async () => {
      const reply = await api.request({ action: "snapshot" });
      if (!reply.ok) throw new Error(reply.error.message);
      const config = reply.data.kind === "snapshot" ? reply.data.value.config : null;
      if (!config?.teamEnabled) return { teams: [], problems: [] };
      const results = await Promise.all(config.teams.map(async (team): Promise<{ team: TeamCatalogEntry["team"]; catalog: TeamCatalog } | { team: TeamCatalogEntry["team"]; message: string }> => {
        const owner = { id: team.id, name: team.name, repository: team.repository };
        try {
          const catalog = await api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } });
          if (!catalog.ok) return { team: owner, message: catalog.error.message };
          return catalog.data.kind === "catalog" ? { team: owner, catalog: catalog.data.value } : { team: owner, message: "The team returned no catalog." };
        } catch (error) {
          return { team: owner, message: error instanceof Error ? error.message : String(error) };
        }
      }));
      const teams: TeamCatalogEntry[] = [];
      const problems: TeamCatalogs["problems"] = [];
      for (const result of results) {
        if ("catalog" in result) teams.push(result);
        else problems.push({ team: result.team.name, message: result.message });
      }
      return { teams, problems };
    })().then(
      (next) => { if (active) setState(next); },
      (error: unknown) => { if (active) setState({ teams: [], problems: [{ team: "", message: error instanceof Error ? error.message : String(error) }] }); },
    );
    return () => { active = false; };
  }, [api, refreshKey, enabled]);
  return state;
}
