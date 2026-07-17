import { ArrowUp, Stop } from "@phosphor-icons/react";
import { type KeyboardEvent, useRef, useState } from "react";
import { supportedThinkingLevels } from "../lib/models";
import type { ModelInfo, ThinkingLevel } from "../types";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { ComposerThinkingPicker } from "./ComposerThinkingPicker";

interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  models: ModelInfo[];
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  onSend: (message: string) => void;
  onAbort: () => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
}

export function Composer({
  disabled,
  streaming,
  models,
  model,
  thinkingLevel,
  onSend,
  onAbort,
  onModelChange,
  onThinkingLevelChange,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const configurationDisabled = disabled || streaming;
  const thinkingLevels = supportedThinkingLevels(model);

  function submit(): void {
    const message = value.trim();
    if (!message || disabled) return;
    onSend(message);
    setValue("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <label className="sr-only" htmlFor="prompt">
          Message Pi
        </label>
        <textarea
          ref={inputRef}
          id="prompt"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? "Start Pi to send a message" : streaming ? "Steer the current run" : "Ask Pi to work on something"}
          onChange={(event) => {
            setValue(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-actions">
          <div className="composer-controls">
            <ComposerModelPicker
              models={models}
              currentModel={model}
              disabled={configurationDisabled || models.length === 0}
              onSelect={onModelChange}
            />
            <ComposerThinkingPicker
              levels={thinkingLevels}
              value={thinkingLevels.includes(thinkingLevel) ? thinkingLevel : thinkingLevels[0]}
              disabled={configurationDisabled || thinkingLevels.length <= 1}
              title={model?.reasoning ? "Thinking level" : "This model does not support reasoning"}
              onSelect={onThinkingLevelChange}
            />
          </div>
          <div className="composer-submit-actions">
            {streaming ? (
              <button className="icon-button stop-button" type="button" onClick={onAbort} aria-label="Stop Pi">
                <Stop size={15} weight="fill" />
              </button>
            ) : null}
            <button
              className="send-button"
              type="button"
              onClick={submit}
              disabled={disabled || value.trim().length === 0}
              aria-label={streaming ? "Steer Pi" : "Send message"}
            >
              <ArrowUp size={17} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
