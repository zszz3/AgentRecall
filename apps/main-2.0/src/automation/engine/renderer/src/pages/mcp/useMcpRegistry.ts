import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
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

export function useMcpRegistry() {
  const [servers, setServers] = useState<McpServerDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<McpServerDefinition>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<
    "load" | "save" | "test" | "delete" | undefined
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
        items.some((item) => item.id === current) ? current : items[0]?.id,
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
  const save = useCallback(async () => {
    if (!draft?.name.trim()) return;
    setBusy("save");
    setError(undefined);
    try {
      const saved = await agentRecallAutomationService().saveMcpServer({
        ...draft,
        updatedAt: Date.now(),
      });
      setServers((items) =>
        [...items.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setDraft(saved);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [draft]);
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
        [...items.filter((item) => item.id !== tested.id), tested].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
      setDraft(tested);
      setDirty(false);
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
      return [...items.filter((item) => !ids.has(item.id)), ...saved].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
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
    test,
    remove,
    importServers,
    setDirty,
  };
}
