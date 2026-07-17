import { textBlocks } from "../lib/content";
import type { AgentMessage } from "../types";
import { MarkdownContent } from "./MarkdownContent";

interface MessageViewProps {
  message: AgentMessage;
  streaming: boolean;
}

function formatMessageTime(timestamp?: number): string | null {
  if (timestamp === undefined) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

export function MessageView({ message, streaming }: MessageViewProps) {
  const isUser = message.role === "user";
  const blocks = textBlocks(message);
  const text = blocks.filter((block) => block.type === "text");
  const images = Array.isArray(message.content)
    ? message.content.flatMap((block, index) =>
      block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
        ? [{ key: `image-${index}`, src: `data:${block.mimeType};base64,${block.data}` }]
        : [],
    )
    : [];
  const hasThinking = !isUser && blocks.some((block) => block.type === "thinking");
  const time = formatMessageTime(message.timestamp);

  if (streaming && hasThinking && text.length === 0) {
    return <div className="thinking-status" role="status">Thinking...</div>;
  }
  if (text.length === 0 && images.length === 0) return null;

  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      <div className="message-stack">
        <div className="message-body">
          {images.length > 0 ? (
            <div className="message-images">
              {images.map((image) => <img key={image.key} src={image.src} alt="Attached image" />)}
            </div>
          ) : null}
          {text.map((block, index) => (
            <div className="markdown" key={`${block.type}-${index}`}>
              <MarkdownContent>{block.text}</MarkdownContent>
            </div>
          ))}
          {streaming ? <span className="stream-caret" aria-label="Pi is responding" /> : null}
        </div>
        <footer className="message-meta">
          <span>{isUser ? "You" : "Pi"}</span>
          {time ? <time dateTime={new Date(message.timestamp!).toISOString()}>{time}</time> : null}
        </footer>
      </div>
    </article>
  );
}
