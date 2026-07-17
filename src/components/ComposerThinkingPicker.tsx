import { Brain, CaretDown, Check } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "../types";

interface ComposerThinkingPickerProps {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  disabled: boolean;
  title: string;
  onSelect: (level: ThinkingLevel) => void;
}

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function ComposerThinkingPicker({
  levels,
  value,
  disabled,
  title,
  onSelect,
}: ComposerThinkingPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="thinking-picker" ref={rootRef}>
      <button
        className="composer-control thinking-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        <Brain size={14} />
        <span>{thinkingLabels[value]}</span>
        <CaretDown size={11} aria-hidden="true" />
      </button>

      {open ? (
        <div className="thinking-popover" role="listbox" aria-label="Thinking level">
          {levels.map((level) => {
            const active = level === value;
            return (
              <button
                className={`thinking-option ${active ? "active" : ""}`}
                type="button"
                role="option"
                aria-selected={active}
                key={level}
                onClick={() => {
                  onSelect(level);
                  setOpen(false);
                }}
              >
                <span>{thinkingLabels[level]}</span>
                {active ? <Check size={13} weight="bold" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
