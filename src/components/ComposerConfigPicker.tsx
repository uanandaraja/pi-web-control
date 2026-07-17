import { CaretDown, CaretLeft, CaretRight, Check, Cube, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { modelKey, modelLabel } from "../lib/models";
import type { ModelInfo, ThinkingLevel } from "../types";

interface ProviderBrand {
  label: string;
  lightLogo: string;
  darkLogo?: string;
}

interface ComposerConfigPickerProps {
  models: ModelInfo[];
  currentModel: ModelInfo | null;
  thinkingLevels: ThinkingLevel[];
  thinkingLevel: ThinkingLevel;
  disabled: boolean;
  onModelSelect: (model: ModelInfo) => void;
  onThinkingLevelSelect: (level: ThinkingLevel) => void;
}

type ConfigPanel = "model" | "effort" | null;

const providerBrands: Record<string, ProviderBrand> = {
  google: {
    label: "Google",
    lightLogo: "/provider-logos/google.svg",
  },
  "openai-codex": {
    label: "OpenAI",
    lightLogo: "/provider-logos/openai.svg",
    darkLogo: "/provider-logos/openai-dark.svg",
  },
};

const effortLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function providerBrand(provider?: string): ProviderBrand | undefined {
  if (!provider) return undefined;
  return providerBrands[provider.toLowerCase()];
}

function compactModelLabel(model?: ModelInfo | null): string {
  const label = modelLabel(model);
  return model?.provider === "openai-codex" ? label.replace(/^GPT-/i, "") : label;
}

function ProviderLogo({ provider }: { provider?: string }) {
  const brand = providerBrand(provider);
  const [failed, setFailed] = useState(false);

  if (!brand || failed) return <Cube size={14} aria-hidden="true" />;

  return (
    <picture className="provider-logo" aria-hidden="true">
      {brand.darkLogo ? <source media="(prefers-color-scheme: dark)" srcSet={brand.darkLogo} /> : null}
      <img src={brand.lightLogo} alt="" onError={() => setFailed(true)} />
    </picture>
  );
}

export function ComposerConfigPicker({
  models,
  currentModel,
  thinkingLevels,
  thinkingLevel,
  disabled,
  onModelSelect,
  onThinkingLevelSelect,
}: ComposerConfigPickerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<ConfigPanel>(null);
  const [modelQuery, setModelQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const currentKey = currentModel ? modelKey(currentModel) : "";
  const canChangeEffort = Boolean(currentModel?.reasoning) && thinkingLevels.length > 1;

  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    const query = modelQuery.trim().toLocaleLowerCase();
    for (const model of models) {
      const searchable = [compactModelLabel(model), model.name, model.id, model.provider]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
      const providerModels = groups.get(model.provider) ?? [];
      providerModels.push(model);
      groups.set(model.provider, providerModels);
    }
    for (const providerModels of groups.values()) {
      providerModels.sort((modelA, modelB) => {
        const keyA = modelKey(modelA);
        const keyB = modelKey(modelB);
        if (keyA === currentKey) return -1;
        if (keyB === currentKey) return 1;
        return modelNameCollator.compare(compactModelLabel(modelB), compactModelLabel(modelA));
      });
    }
    return [...groups.entries()].sort(([providerA], [providerB]) => {
      if (providerA === currentModel?.provider) return -1;
      if (providerB === currentModel?.provider) return 1;
      return providerA.localeCompare(providerB);
    });
  }, [currentKey, currentModel?.provider, modelQuery, models]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPanel(null);
        setModelQuery("");
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (panel) {
        setPanel(null);
        setModelQuery("");
      } else {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, panel]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setPanel(null);
    setModelQuery("");
  }, [disabled]);

  function closePicker(): void {
    setOpen(false);
    setPanel(null);
    setModelQuery("");
  }

  return (
    <div className="config-picker" ref={rootRef}>
      <button
        className="composer-control config-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={currentModel ? `${currentModel.provider}/${currentModel.id} · ${effortLabels[thinkingLevel]}` : "Choose model"}
        onClick={() => {
          setOpen((current) => !current);
          setPanel(null);
          setModelQuery("");
        }}
      >
        <ProviderLogo provider={currentModel?.provider} />
        <span className="config-trigger-model">{compactModelLabel(currentModel)}</span>
        {canChangeEffort ? <span className="config-trigger-effort">{effortLabels[thinkingLevel]}</span> : null}
        <CaretDown size={11} aria-hidden="true" />
      </button>

      {open ? (
        <section className="config-popover" role="dialog" aria-label="Model settings">
          <button
            className={panel === "model" ? "active" : ""}
            type="button"
            onClick={() => {
              setModelQuery("");
              setPanel("model");
            }}
          >
            <span>Model</span>
            <span className="config-row-value">{compactModelLabel(currentModel)}</span>
            <CaretRight size={13} aria-hidden="true" />
          </button>
          <button
            className={panel === "effort" ? "active" : ""}
            type="button"
            disabled={!canChangeEffort}
            onClick={() => setPanel("effort")}
          >
            <span>Effort</span>
            <span className="config-row-value">{effortLabels[thinkingLevel]}</span>
            <CaretRight size={13} aria-hidden="true" />
          </button>
        </section>
      ) : null}

      {open && panel ? (
        <section
          className={`config-submenu${panel === "model" ? " config-submenu-model" : ""}`}
          aria-label={panel === "model" ? "Choose model" : "Choose effort"}
        >
          <button
            className="config-submenu-back"
            type="button"
            onClick={() => {
              setPanel(null);
              setModelQuery("");
            }}
          >
            <CaretLeft size={13} />
            Settings
          </button>
          <div className="config-submenu-title">{panel === "model" ? "Model" : "Effort"}</div>

          {panel === "model" ? (
            <>
              <label className="config-model-search">
                <MagnifyingGlass size={13} aria-hidden="true" />
                <span className="sr-only">Search models</span>
                <input
                  type="search"
                  value={modelQuery}
                  placeholder="Search models"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => setModelQuery(event.target.value)}
                />
              </label>
              <div className="config-option-list" role="listbox" aria-label="Available models">
                {modelGroups.length > 0 ? modelGroups.map(([provider, providerModels]) => (
                  <div className="config-provider-group" key={provider}>
                    <div className="config-provider-heading">
                      <ProviderLogo provider={provider} />
                      <span>{providerBrand(provider)?.label ?? provider}</span>
                    </div>
                    {providerModels.map((model) => {
                      const key = modelKey(model);
                      const active = key === currentKey;
                      return (
                        <button
                          className={`config-option ${active ? "active" : ""}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          key={key}
                          onClick={() => {
                            onModelSelect(model);
                            closePicker();
                          }}
                        >
                          <span>{compactModelLabel(model)}</span>
                          {active ? <Check size={14} weight="bold" /> : null}
                        </button>
                      );
                    })}
                  </div>
                )) : <div className="config-model-empty">No models found</div>}
              </div>
            </>
          ) : (
            <div className="config-option-list" role="listbox" aria-label="Thinking effort">
              {thinkingLevels.map((level) => {
                const active = level === thinkingLevel;
                return (
                  <button
                    className={`config-option ${active ? "active" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    key={level}
                    onClick={() => {
                      onThinkingLevelSelect(level);
                      closePicker();
                    }}
                  >
                    <span>{effortLabels[level]}</span>
                    {active ? <Check size={14} weight="bold" /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
