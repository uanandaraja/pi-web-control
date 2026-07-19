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
        table: ({ children: tableChildren, node: _node, ...props }) => (
          <div className="markdown-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
            <table {...props}>{tableChildren}</table>
          </div>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}
