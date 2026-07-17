import { ArrowUp, File, Paperclip, Stop, X } from "@phosphor-icons/react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";
import { supportedThinkingLevels } from "../lib/models";
import type { ModelInfo, PromptSubmission, ThinkingLevel } from "../types";
import { ComposerConfigPicker } from "./ComposerConfigPicker";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  data: string;
  previewUrl?: string;
}

interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  models: ModelInfo[];
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  onSend: (submission: PromptSubmission) => void;
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const configurationDisabled = disabled || streaming;
  const thinkingLevels = supportedThinkingLevels(model);
  const hasContent = value.trim().length > 0 || attachments.length > 0;

  function readFile(file: globalThis.File): Promise<{ data: string; dataUrl: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result !== "string") {
          reject(new Error(`Could not read ${file.name}`));
          return;
        }
        const commaIndex = reader.result.indexOf(",");
        if (commaIndex === -1) {
          reject(new Error(`Could not encode ${file.name}`));
          return;
        }
        resolve({ data: reader.result.slice(commaIndex + 1), dataUrl: reader.result });
      });
      reader.addEventListener("error", () => reject(reader.error ?? new Error(`Could not read ${file.name}`)));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files: globalThis.File[]): Promise<void> {
    if (files.length === 0 || disabled || readingAttachments) return;

    setAttachmentError("");
    setReadingAttachments(true);
    try {
      const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      const selected = files.slice(0, availableSlots);
      const next: PendingAttachment[] = [];
      const errors: string[] = [];
      let totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);

      if (availableSlots === 0) {
        errors.push(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      } else if (files.length > selected.length) {
        errors.push(`Only the first ${availableSlots} file${availableSlots === 1 ? "" : "s"} fit.`);
      }

      for (const file of selected) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          errors.push(`${file.name} is larger than 5 MB.`);
          continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          errors.push("Attachments can total up to 8 MB.");
          break;
        }

        try {
          const encoded = await readFile(file);
          const mimeType = file.type || "application/octet-stream";
          const kind = NATIVE_IMAGE_TYPES.has(mimeType) ? "image" : "file";
          next.push({
            id: crypto.randomUUID(),
            name: file.name || "attachment",
            mimeType,
            size: file.size,
            kind,
            data: encoded.data,
            ...(kind === "image" ? { previewUrl: encoded.dataUrl } : {}),
          });
          totalBytes += file.size;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Could not read ${file.name}.`);
        }
      }

      if (next.length > 0) setAttachments((current) => [...current, ...next]);
      setAttachmentError(errors[0] ?? "");
    } finally {
      setReadingAttachments(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function submit(): void {
    if (!hasContent || disabled || readingAttachments) return;
    const message = value.trim() || "Please inspect the attached files.";
    onSend({
      message,
      images: attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ type: "image", data: attachment.data, mimeType: attachment.mimeType })),
      files: attachments
        .filter((attachment) => attachment.kind === "file")
        .map((attachment) => ({ name: attachment.name, data: attachment.data, mimeType: attachment.mimeType })),
    });
    setValue("");
    setAttachments([]);
    setAttachmentError("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (streaming) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    void addFiles(Array.from(event.target.files ?? []));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div className="composer-wrap">
      <div
        className={`composer${dragging ? " composer-dragging" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) setDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <label className="sr-only" htmlFor="prompt">
          Message Pi
        </label>
        <textarea
          ref={inputRef}
          id="prompt"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? "Start Pi to send a message" : streaming ? "Add your next message" : "Ask Pi to work on something"}
          onChange={(event) => {
            setValue(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        {attachments.length > 0 ? (
          <div className="composer-attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <div className={`composer-attachment composer-attachment-${attachment.kind}`} key={attachment.id}>
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <span className="composer-file-icon" aria-hidden="true">
                    <File size={16} />
                  </span>
                )}
                <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X size={12} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? <div className="composer-attachment-error" role="status">{attachmentError}</div> : null}
        <div className="composer-actions">
          <div className="composer-controls">
            <input ref={fileInputRef} className="sr-only" type="file" multiple onChange={handleFileInput} />
            <ComposerConfigPicker
              models={models}
              currentModel={model}
              thinkingLevels={thinkingLevels}
              thinkingLevel={thinkingLevels.includes(thinkingLevel) ? thinkingLevel : thinkingLevels[0]}
              disabled={configurationDisabled || models.length === 0}
              onModelSelect={onModelChange}
              onThinkingLevelSelect={onThinkingLevelChange}
            />
            <button
              className="composer-control attach-button"
              type="button"
              disabled={disabled || readingAttachments || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach images or files"
              title="Attach images or files"
            >
              <Paperclip size={15} />
            </button>
          </div>
          <div className="composer-submit-actions">
            <button
              className={`send-button${streaming ? " stop-active" : ""}`}
              type="button"
              onClick={streaming ? onAbort : submit}
              disabled={streaming ? disabled : disabled || readingAttachments || !hasContent}
              aria-label={streaming ? "Stop Pi" : "Send message"}
            >
              {streaming ? <Stop size={13} weight="fill" /> : <ArrowUp size={17} weight="bold" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
