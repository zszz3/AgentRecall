import { Markdown } from "../Markdown";

export function MarkdownDocument({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`markdown-document ${className}`.trim()}>
      <Markdown text={text} />
    </div>
  );
}
