import { Check, Search, X } from "lucide-react";
import type { AgentProviderPreset } from "../../../../shared/provider-presets";
import type { Language } from "../../app/language";

const CATEGORY_ORDER = ["local", "official", "cn_official", "cloud_provider", "aggregator", "third_party", "custom"];

function categoryForPreset(preset: AgentProviderPreset): string {
  return preset.category ?? (preset.id.includes("custom") ? "custom" : "third_party");
}

function categoryLabel(category: string, language: Language): string {
  const labels: Record<string, [string, string]> = {
    local: ["本地配置", "Local config"],
    official: ["官方", "Official"],
    cn_official: ["国内官方 / Coding Plan", "China official / Coding plan"],
    cloud_provider: ["云服务商", "Cloud providers"],
    aggregator: ["聚合服务", "Aggregators"],
    third_party: ["第三方", "Third party"],
    custom: ["自定义", "Custom"],
  };
  const label = labels[category] ?? ["其他", "Other"];
  return language === "zh" ? label[0] : label[1];
}

export interface RuntimeProviderPickerProps {
  language: Language;
  presets: AgentProviderPreset[];
  selectedPresetId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (preset: AgentProviderPreset) => void | Promise<void>;
  onClose: () => void;
}

export function RuntimeProviderPicker({
  language,
  presets,
  selectedPresetId,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: RuntimeProviderPickerProps) {
  const zh = language === "zh";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPresets = normalizedQuery
    ? presets.filter((preset) =>
        [preset.label, preset.providerName, preset.modelProvider, preset.id]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery)),
      )
    : presets;
  const categories = [...new Set(filteredPresets.map(categoryForPreset))].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left);
    const rightIndex = CATEGORY_ORDER.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  });

  return (
    <div className="runtime-provider-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="runtime-provider-picker"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "更换 Provider" : "Change provider"}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="runtime-provider-picker-head">
          <div>
            <strong>{zh ? "更换 Provider" : "Change provider"}</strong>
            <span>{zh ? "选择后会更新当前配置" : "Selecting one updates the current config"}</span>
          </div>
          <button className="icon-btn" type="button" aria-label={zh ? "关闭" : "Close"} onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <label className="runtime-provider-search">
          <Search size={14} aria-hidden="true" />
          <input
            autoFocus
            aria-label={zh ? "搜索 Provider" : "Search providers"}
            value={query}
            placeholder={zh ? "搜索名称或服务商" : "Search name or provider"}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
        </label>

        <div className="runtime-provider-picker-body">
          {filteredPresets.length === 0 ? (
            <div className="runtime-provider-empty">
              <strong>{zh ? "没有匹配的 Provider" : "No matching provider"}</strong>
              <span>{zh ? "换一个关键词试试。" : "Try a different search."}</span>
            </div>
          ) : (
            categories.map((category) => (
              <section className="runtime-provider-picker-category" key={category}>
                <span>{categoryLabel(category, language)}</span>
                <div className="runtime-provider-picker-options">
                  {filteredPresets.filter((preset) => categoryForPreset(preset) === category).map((preset) => {
                    const selected = preset.id === selectedPresetId;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`runtime-provider-picker-option ${selected ? "is-active" : ""}`}
                        aria-pressed={selected}
                        onClick={() => void onSelect(preset)}
                      >
                        <span>
                          <strong>{preset.label}</strong>
                          {preset.providerName && preset.providerName !== preset.label ? <small>{preset.providerName}</small> : null}
                        </span>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
