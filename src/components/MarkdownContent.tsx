import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkChildren, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {linkChildren}
          </a>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}
