import { Check, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ExtensionRequest } from "../types";

interface ExtensionDialogProps {
  request: ExtensionRequest;
  onRespond: (response: Record<string, unknown>) => void;
}

export function ExtensionDialog({ request, onRespond }: ExtensionDialogProps) {
  const [value, setValue] = useState(request.prefill ?? "");

  useEffect(() => setValue(request.prefill ?? ""), [request]);

  function cancel(): void {
    onRespond({ type: "extension_ui_response", id: request.id, cancelled: true });
  }

  function submitValue(): void {
    onRespond({ type: "extension_ui_response", id: request.id, value });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading">
          <div>
            <div className="dialog-kicker">Pi needs your input</div>
            <h2 id="dialog-title">{request.title ?? "Continue?"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={cancel} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        {request.message ? <p className="dialog-message">{request.message}</p> : null}

        {request.method === "select" ? (
          <div className="select-options">
            {request.options?.map((option) => (
              <button
                className="select-option"
                key={option}
                type="button"
                onClick={() => onRespond({ type: "extension_ui_response", id: request.id, value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {request.method === "input" || request.method === "editor" ? (
          <div className="dialog-field">
            <label htmlFor="dialog-value">Response</label>
            {request.method === "editor" ? (
              <textarea id="dialog-value" rows={7} value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
            ) : (
              <input
                id="dialog-value"
                value={value}
                placeholder={request.placeholder}
                onChange={(event) => setValue(event.target.value)}
                autoFocus
              />
            )}
          </div>
        ) : null}

        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={cancel}>
            Cancel
          </button>
          {request.method === "confirm" ? (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onRespond({ type: "extension_ui_response", id: request.id, confirmed: false })}
              >
                <X size={16} />
                Deny
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => onRespond({ type: "extension_ui_response", id: request.id, confirmed: true })}
              >
                <Check size={16} weight="bold" />
                Allow
              </button>
            </>
          ) : request.method === "input" || request.method === "editor" ? (
            <button className="primary-button" type="button" onClick={submitValue}>
              Submit
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
