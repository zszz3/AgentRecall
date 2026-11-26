import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AgentModelImports } from "../../../../core/agent-model-config";
import type {
  GatewayAgentId,
  GatewayProviderProtocol,
  GatewayRouteTarget,
  GatewaySnapshot,
} from "../../../../shared/ipc/model-gateway";
import { localize, type LanguageMode } from "../../language";
import { CatalogPage } from "../../ui/catalog";
import { Segmented } from "../../ui/primitives";
import { GatewayPanel, type GatewaySectionView } from "./gateway-panel";

/** Entries another page can ask the Gateway page to open. */
export type ProviderView = GatewaySectionView;

export function ProviderPage({ language, requestedView, onRequestedViewConsumed }: {
  language: LanguageMode;
  /** Opens a specific section on behalf of another page, such as Memory asking to configure a model. */
  requestedView?: ProviderView | null;
  onRequestedViewConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [selection, setSelection] = useState<ProviderView>(requestedView ?? "gateway-overview");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [gatewaySnapshot, setGatewaySnapshot] = useState<GatewaySnapshot | null>(null);
  const [gatewayImports, setGatewayImports] = useState<AgentModelImports | null>(null);
  const [gatewayFeedback, setGatewayFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!requestedView) return;
    choose(requestedView);
    onRequestedViewConsumed?.();
  }, [requestedView]);

  useEffect(() => {
    let cancelled = false;
    void window.sessionSearch.getGatewaySnapshot?.().then((snap) => {
      if (!cancelled) setGatewaySnapshot(snap);
    }).catch(() => undefined);
    void window.sessionSearch.listAgentModelImports?.().then((scanned) => {
      if (!cancelled) setGatewayImports(scanned);
    }).catch(() => undefined);
    const offGateway = window.sessionSearch.onGatewaySnapshot?.((snap) => {
      if (!cancelled) setGatewaySnapshot(snap);
    }) ?? (() => undefined);
    return () => {
      cancelled = true;
      offGateway();
    };
  }, []);

  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setGatewayFeedback(null);
    try { await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (alive.current) {
        setGatewayFeedback({ kind: "error", message });
      }
    }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function choose(next: ProviderView) {
    if (busyRef.current) return;
    setSelection(next);
    setGatewayFeedback(null);
  }

  const handleSetGatewayEnabled = async (enabled: boolean, port?: number) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayEnabled(enabled, port);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({
        kind: "success",
        message: next.status.running
          ? l(`Gateway listening on ${next.status.baseUrl}`, `本地网关已启动：${next.status.baseUrl}`)
          : l("Local model gateway stopped.", "本地模型网关已停止。"),
      });
    });
  };

  const handleSaveGatewayProvider = async (input: {
    id?: string;
    name: string;
    protocol: GatewayProviderProtocol;
    baseUrl: string;
    defaultModel: string;
    models?: string[];
    enabled?: boolean;
    apiKey?: string;
    importId?: string;
  }) => {
    await run(async () => {
      const next = await window.sessionSearch.saveGatewayProvider(input);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway upstream provider saved.", "上游 Provider 已保存。") });
    });
  };

  const handleTestGatewayProvider = async (providerId: string) => {
    return window.sessionSearch.testGatewayProvider(providerId);
  };

  const handleRemoveGatewayProvider = async (providerId: string) => {
    await run(async () => {
      const next = await window.sessionSearch.removeGatewayProvider(providerId);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway provider removed.", "上游 Provider 已删除。") });
    });
  };

  const handleSetGatewayRouting = async (primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayRouting(primary, fallbacks);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway routing updated.", "路由规则已更新。") });
    });
  };

  const handleSetGatewayAgentModel = async (agentId: GatewayAgentId, target: GatewayRouteTarget | null) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayAgentModel(agentId, target);
      if (!alive.current) return;
      setGatewaySnapshot(next);
    });
  };

  const handleSetGatewayAgentRecallModel = async (target: GatewayRouteTarget | null) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayAgentRecallModel(target);
      if (!alive.current) return;
      setGatewaySnapshot(next);
    });
  };

  const handleWireGatewayAgent = async (agentId: GatewayAgentId) => {
    await run(async () => {
      // Automatically turn on the local gateway when connecting an agent so one click just works.
      if (gatewaySnapshot && !gatewaySnapshot.status.running) {
        const started = await window.sessionSearch.setGatewayEnabled(true, gatewaySnapshot.config.port);
        if (!alive.current) return;
        setGatewaySnapshot(started);
      }
      const result = await window.sessionSearch.wireGatewayAgent(agentId);
      if (!alive.current) return;
      setGatewaySnapshot(result.snapshot);
      setGatewayFeedback({ kind: "success", message: result.message });
    });
  };

  const handleRestoreGatewayAgent = async (agentId: GatewayAgentId) => {
    await run(async () => {
      const result = await window.sessionSearch.restoreGatewayAgent(agentId);
      if (!alive.current) return;
      setGatewaySnapshot(result.snapshot);
      setGatewayFeedback({ kind: "success", message: result.message });
    });
  };

  const handleClearGatewayRequests = async () => {
    await run(async () => {
      const next = await window.sessionSearch.clearGatewayRequests();
      if (!alive.current) return;
      setGatewaySnapshot(next);
    });
  };

  const wiredCount = gatewaySnapshot?.agents.filter((agent) => agent.wired).length ?? 0;
  const providerCount = gatewaySnapshot?.config.providers.length ?? 0;
  const requestCount = gatewaySnapshot?.requests.length ?? 0;
  const statusMeta = !gatewaySnapshot
    ? l("Unified local model gateway for coding agents and AgentRecall built-in AI", "统一本机模型网关，同时驱动各编码 Agent 与 AgentRecall 内置 AI")
    : [
      gatewaySnapshot.status.running
        ? l(`Running :${gatewaySnapshot.status.port}`, `运行中 :${gatewaySnapshot.status.port}`)
        : l("Off", "未开启"),
      l(`${providerCount} service(s)`, `${providerCount} 个模型服务`),
      ...(wiredCount > 0 ? [l(`${wiredCount} agent(s) connected`, `已接入 ${wiredCount} 个 Agent`)] : []),
    ].join(" · ");

  return <CatalogPage
    title={l("Gateway", "网关")}
    meta={statusMeta}
    actions={
      <Segmented<ProviderView>
        label={l("Gateway view", "网关视图")}
        value={selection}
        onChange={choose}
        options={[
          { value: "gateway-overview", label: l("Gateway setup", "模型网关") },
          { value: "gateway-requests", label: l("Request log", "请求日志"), count: requestCount > 0 ? requestCount : undefined },
        ]}
      />
    }
  >
    <div className="catalog-detail-pane provider-page gateway-page-body" data-page="providers">
      <div className="gateway-page-inner">
        <GatewayPanel
          view={selection}
          snapshot={gatewaySnapshot}
          imports={gatewayImports}
          language={language}
          busy={busy}
          feedback={gatewayFeedback}
          onSetEnabled={handleSetGatewayEnabled}
          onSaveProvider={handleSaveGatewayProvider}
          onRemoveProvider={handleRemoveGatewayProvider}
          onTestProvider={handleTestGatewayProvider}
          onSetRouting={handleSetGatewayRouting}
          onSetAgentModel={handleSetGatewayAgentModel}
          onSetAgentRecallModel={handleSetGatewayAgentRecallModel}
          onWireAgent={handleWireGatewayAgent}
          onRestoreAgent={handleRestoreGatewayAgent}
          onClearRequests={handleClearGatewayRequests}
        />
      </div>
    </div>
  </CatalogPage>;
}
