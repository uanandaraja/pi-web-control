import { CaretDown, Check, Cube, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { modelKey, modelLabel } from "../lib/models";
import type { ModelInfo } from "../types";

interface ProviderBrand {
  label: string;
  lightLogo: string;
  darkLogo?: string;
}

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

function providerBrand(provider?: string): ProviderBrand | undefined {
  if (!provider) return undefined;
  return providerBrands[provider.toLowerCase()];
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

interface ComposerModelPickerProps {
  models: ModelInfo[];
  currentModel: ModelInfo | null;
  disabled: boolean;
  onSelect: (model: ModelInfo) => void;
}

export function ComposerModelPicker({
  models,
  currentModel,
  disabled,
  onSelect,
}: ComposerModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentKey = currentModel ? modelKey(currentModel) : "";

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? models.filter((model) =>
          `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase().includes(normalizedQuery),
        )
      : models;
    const grouped = new Map<string, ModelInfo[]>();
    for (const model of filtered) {
      const providerModels = grouped.get(model.provider) ?? [];
      providerModels.push(model);
      grouped.set(model.provider, providerModels);
    }
    return [...grouped.entries()];
  }, [models, query]);

  useEffect(() => {
    if (!open) return;

    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="composer-picker" ref={rootRef}>
      <button
        className="composer-control model-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={currentModel ? `${currentModel.provider}/${currentModel.id}` : "Choose a Pi model"}
      >
        <ProviderLogo provider={currentModel?.provider} />
        <span>{modelLabel(currentModel)}</span>
        <CaretDown size={11} />
      </button>

      {open ? (
        <section className="model-picker-popover" role="dialog" aria-label="Choose model">
          <div className="model-picker-search">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
            />
          </div>
          <div className="model-picker-list" role="listbox" aria-label="Available models">
            {groups.length > 0 ? groups.map(([provider, providerModels]) => (
              <div className="model-provider-group" key={provider}>
                <div className="model-provider-heading">
                  <ProviderLogo provider={provider} />
                  <span>{providerBrand(provider)?.label ?? provider}</span>
                </div>
                {providerModels.map((model) => {
                  const key = modelKey(model);
                  const active = key === currentKey;
                  return (
                    <button
                      className={`model-option ${active ? "active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      key={key}
                      onClick={() => {
                        onSelect(model);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="model-option-copy">
                        <strong>{modelLabel(model)}</strong>
                        <span>{model.id}</span>
                      </span>
                      {model.reasoning ? <span className="model-capability">Reasoning</span> : null}
                      {active ? <Check size={14} weight="bold" /> : null}
                    </button>
                  );
                })}
              </div>
            )) : (
              <div className="model-picker-empty">No matching models</div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
