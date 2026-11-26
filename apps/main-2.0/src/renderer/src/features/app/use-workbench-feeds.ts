import { useEffect, useMemo, useState } from "react";
import type { McpServerDefinition } from "../../../../automation/contracts";
import type { InstalledSkill } from "../../../../core/skill-manager";
import type { IslandSnapshot } from "../../../../shared/ipc/island";
import type { GatewaySnapshot } from "../../../../shared/ipc/model-gateway";
import type { AppPage } from "../../components/app-navigation";

export interface EvalFindingCount {
  skill: string;
  low: number;
  medium: number;
}

export interface WorkbenchFeeds {
  gatewaySnapshot: GatewaySnapshot | null;
  gatewayBuiltInModelLabel: string | null;
  islandSnapshot: IslandSnapshot | null;
  workbenchMcpServers: McpServerDefinition[] | null;
  workbenchSkills: InstalledSkill[] | null;
  evalFindingCounts: EvalFindingCount[];
}

export function useWorkbenchFeeds(options: {
  activePage: AppPage;
  listMcpServers: () => Promise<McpServerDefinition[]>;
  evalEnabled: boolean;
  skillsSnapshot: unknown;
}): WorkbenchFeeds {
  const { activePage, listMcpServers, evalEnabled, skillsSnapshot } = options;
  const [workbenchMcpServers, setWorkbenchMcpServers] = useState<McpServerDefinition[] | null>(null);
  const [workbenchSkills, setWorkbenchSkills] = useState<InstalledSkill[] | null>(null);
  const [islandSnapshot, setIslandSnapshot] = useState<IslandSnapshot | null>(null);
  const [gatewaySnapshot, setGatewaySnapshot] = useState<GatewaySnapshot | null>(null);
  const [evalFindingCounts, setEvalFindingCounts] = useState<EvalFindingCount[]>([]);

  const gatewayBuiltInModelLabel = useMemo(() => {
    if (!gatewaySnapshot) return null;
    const { config } = gatewaySnapshot;
    const fallbackProvider = config.providers.find((provider) => provider.enabled);
    const target = config.agentRecallModel
      ?? config.primary
      ?? (fallbackProvider ? { providerId: fallbackProvider.id, model: fallbackProvider.defaultModel } : null);
    if (!target) return null;
    const provider = config.providers.find((item) => item.id === target.providerId);
    return provider ? `${provider.name} · ${target.model}` : target.model;
  }, [gatewaySnapshot]);

  useEffect(() => {
    let active = true;
    const offGateway = window.sessionSearch.onGatewaySnapshot?.((next) => {
      if (active) setGatewaySnapshot(next);
    }) ?? (() => undefined);
    void window.sessionSearch.getGatewaySnapshot?.().then((snapshot) => {
      if (active) setGatewaySnapshot(snapshot);
    }).catch(() => undefined);
    return () => {
      active = false;
      offGateway();
    };
  }, []);

  useEffect(() => {
    if (activePage !== "workbench") return;
    let active = true;
    const timers: number[] = [];
    const offIsland = window.sessionSearch.onIslandSnapshot?.((next) => {
      if (active) setIslandSnapshot(next);
    }) ?? (() => undefined);
    void window.sessionSearch.getIslandSnapshot?.().then((snapshot) => {
      if (active) setIslandSnapshot(snapshot);
    }).catch(() => undefined);
    const tasks: Array<() => Promise<void>> = [
      async () => {
        try {
          const servers = await listMcpServers();
          if (active) setWorkbenchMcpServers(servers);
        } catch {
          if (active) setWorkbenchMcpServers([]);
        }
      },
      async () => {
        try {
          const snapshot = await window.sessionSearch.listSkills();
          if (active) setWorkbenchSkills(snapshot.skills);
        } catch {
          if (active) setWorkbenchSkills([]);
        }
      },
    ];
    const frameId = window.requestAnimationFrame(() => {
      tasks.forEach((task, index) => {
        timers.push(window.setTimeout(() => {
          if (active) void task();
        }, index * 50));
      });
    });
    return () => {
      active = false;
      offIsland();
      window.cancelAnimationFrame(frameId);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [activePage, listMcpServers]);

  useEffect(() => {
    if (!evalEnabled) {
      setEvalFindingCounts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const counts = await window.sessionSearch.getSkillEvalFindingCounts();
        if (!cancelled) setEvalFindingCounts(counts);
      } catch {
        // Eval is opt-in; failures here are non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evalEnabled, skillsSnapshot]);

  return {
    gatewaySnapshot,
    gatewayBuiltInModelLabel,
    islandSnapshot,
    workbenchMcpServers,
    workbenchSkills,
    evalFindingCounts,
  };
}
