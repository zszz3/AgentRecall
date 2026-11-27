import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpSecretKind, McpServerDefinition } from "../../../../shared/mcp/types";
import { agentRecallAutomationService } from "../../app/services/agent-recall-service";

function createServer(): McpServerDefinition {
  const now = Date.now();
  return {
    id: `mcp-${now}`,
    name: "New MCP Server",
    transport: "stdio",
    args: [],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: now,
    updatedAt: now,
  };
}

function sortServers(items: McpServerDefinition[]): McpServerDefinition[] {
  return [...items].sort((left, right) => {
    if (Boolean(left.managed) !== Boolean(right.managed)) {
      return left.managed ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function useMcpRegistry() {
  const [servers, setServers] = useState<McpServerDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<McpServerDefinition>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<
    "load" | "save" | "test" | "restart" | "oauth" | "secret" | "delete" | undefined
  >("load");
  const [error, setError] = useState<string>();
  const selected = useMemo(
    () => servers.find((item) => item.id === selectedId),
    [servers, selectedId],
  );

  const load = useCallback(async () => {
    setBusy("load");
    setError(undefined);
    try {
      const items = await agentRecallAutomationService().listMcpServers();
      setServers(items);
      setSelectedId((current) =>
        items.some((item) => item.id === current)
          ? current
          : (items.find((item) => !item.managed) ?? items[0])?.id,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setDraft(
      selected
        ? {
            ...selected,
            args: [...selected.args],
            env: { ...selected.env },
            tools: [...selected.tools],
            disabledTools: [...(selected.disabledTools ?? [])],
          }
        : undefined,
    );
    setDirty(false);
  }, [selected]);

  const update = useCallback((value: McpServerDefinition) => {
    setDraft(value);
    setDirty(true);
  }, []);
  const toggleTool = useCallback((name: string) => {
    setDraft((current) => {
      if (!current) return current;
      const disabled = new Set(current.disabledTools ?? []);
      if (disabled.has(name)) disabled.delete(name);
      else disabled.add(name);
      return { ...current, disabledTools: [...disabled] };
    });
    setDirty(true);
  }, []);
  const create = useCallback(() => {
    const value = createServer();
    setServers((items) => [...items, value]);
    setSelectedId(value.id);
    setDraft(value);
    setDirty(true);
  }, []);
  const select = useCallback((id: string) => setSelectedId(id), []);
  const save = useCallback(
    async (next?: McpServerDefinition) => {
      const value = next ?? draft;
      if (!value?.name.trim()) return;
      setBusy("save");
      setError(undefined);
      try {
        const saved = await agentRecallAutomationService().saveMcpServer({
          ...value,
          updatedAt: Date.now(),
        });
        setServers((items) =>
          sortServers([...items.filter((item) => item.id !== saved.id), saved]),
        );
        setDraft(saved);
        setDirty(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [draft],
  );
  const toggleEnabled = useCallback(async () => {
    if (!draft) return;
    await save({ ...draft, enabled: !draft.enabled });
  }, [draft, save]);
  const toggleServerEnabled = useCallback(
    async (id: string) => {
      // Toggle straight from the server list without changing the current
      // selection. When the toggled server is the one being edited, keep its
      // unsaved edits by flipping the draft; otherwise flip the stored copy.
      const base = draft?.id === id && dirty ? draft : servers.find((item) => item.id === id);
      if (!base?.name.trim()) return;
      setBusy("save");
      setError(undefined);
      try {
        const saved = await agentRecallAutomationService().saveMcpServer({
          ...base,
          enabled: !base.enabled,
          updatedAt: Date.now(),
        });
        setServers((items) =>
          sortServers([...items.filter((item) => item.id !== saved.id), saved]),
        );
        setDraft((current) => (current && current.id === saved.id ? saved : current));
        if (draft?.id === id) setDirty(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [draft, dirty, servers],
  );
  const test = useCallback(async () => {
    if (!draft) return;
    setBusy("test");
    setError(undefined);
    try {
      const tested = await agentRecallAutomationService().testMcpServer({
        ...draft,
        updatedAt: Date.now(),
      });
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== tested.id), tested]),
      );
      setDraft(tested);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const restart = useCallback(async () => {
    if (!draft) return;
    setBusy("restart");
    setError(undefined);
    try {
      const restarted = await agentRecallAutomationService().restartMcpServer(draft.id);
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== restarted.id), restarted]),
      );
      setDraft(restarted);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const saveSecret = useCallback(async (kind: McpSecretKind, key: string, value: string) => {
    if (!draft) return;
    setBusy("secret");
    setError(undefined);
    try {
      const updated = await agentRecallAutomationService().setMcpSecret({
        serverId: draft.id,
        kind,
        key,
        value,
      });
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== updated.id), updated]),
      );
      setDraft((current) => (current && current.id === updated.id
        ? { ...current, secretSummary: updated.secretSummary }
        : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const deleteSecret = useCallback(async (kind: McpSecretKind, key: string) => {
    if (!draft) return;
    setBusy("secret");
    setError(undefined);
    try {
      const updated = await agentRecallAutomationService().deleteMcpSecret({
        serverId: draft.id,
        kind,
        key,
      });
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== updated.id), updated]),
      );
      setDraft((current) => (current && current.id === updated.id
        ? { ...current, secretSummary: updated.secretSummary }
        : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const authorizeOAuth = useCallback(async () => {
    if (!draft) return;
    setBusy("oauth");
    setError(undefined);
    try {
      const updated = await agentRecallAutomationService().authorizeMcpOAuth(draft.id);
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== updated.id), updated]),
      );
      setDraft(updated);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const revokeOAuth = useCallback(async () => {
    if (!draft) return;
    setBusy("oauth");
    setError(undefined);
    try {
      const updated = await agentRecallAutomationService().revokeMcpOAuth(draft.id);
      setServers((items) =>
        sortServers([...items.filter((item) => item.id !== updated.id), updated]),
      );
      setDraft((current) => (current && current.id === updated.id
        ? { ...current, secretSummary: updated.secretSummary }
        : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
  const remove = useCallback(async () => {
    if (!draft) return;
    setBusy("delete");
    setError(undefined);
    try {
      await agentRecallAutomationService().deleteMcpServer(draft.id);
      const next = servers.filter((item) => item.id !== draft.id);
      setServers(next);
      setSelectedId(next[0]?.id);
      setDraft(undefined);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft, servers]);
  const importServers = useCallback(async (definitions: McpServerDefinition[]) => {
    const saved: McpServerDefinition[] = [];
    for (const definition of definitions) {
      saved.push(await agentRecallAutomationService().saveMcpServer(definition));
    }
    setServers((items) => {
      const ids = new Set(saved.map((item) => item.id));
      return sortServers([...items.filter((item) => !ids.has(item.id)), ...saved]);
    });
    if (saved[0]) setSelectedId(saved[0].id);
    return saved.length;
  }, []);
  return {
    servers,
    draft,
    dirty,
    busy,
    error,
    create,
    select,
    update,
    toggleTool,
    save,
    toggleEnabled,
    toggleServerEnabled,
    test,
    restart,
    saveSecret,
    deleteSecret,
    authorizeOAuth,
    revokeOAuth,
    remove,
    importServers,
    setDirty,
  };
}
