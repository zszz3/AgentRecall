import { Children, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, X } from "lucide-react";
import { normalizeExternalLink } from "../../core/external-link";
import { localize, type LanguageMode } from "./language";

type MarkdownElementProps<Tag extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<Tag> & {
  node?: unknown;
};

type CopyState = "idle" | "copied" | "failed";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function codeLanguage(children: ReactNode): string | null {
  const codeElement = Children.toArray(children).find((child) => isValidElement<{ className?: string }>(child));
  if (!isValidElement<{ className?: string }>(codeElement)) return null;
  return codeElement.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? null;
}

function MarkdownCodeBlock({
  children,
  language,
  node: _node,
  ...props
}: MarkdownElementProps<"pre"> & { language: LanguageMode }): ReactElement {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);
  const code = nodeText(children).replace(/\n$/, "");
  const declaredLanguage = codeLanguage(children);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  }

  const copyLabel = copyState === "copied"
    ? localize(language, "Copied", "已复制")
    : copyState === "failed"
      ? localize(language, "Copy failed", "复制失败")
      : localize(language, "Copy code", "复制代码");

  return (
    <div className="md-code-block">
      <div className="md-code-toolbar">
        <span className="md-code-language">{declaredLanguage ?? localize(language, "Code", "代码")}</span>
        <button
          type="button"
          className={`md-code-copy ${copyState}`}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copyCode()}
        >
          {copyState === "copied" ? <Check size={13} /> : copyState === "failed" ? <X size={13} /> : <Copy size={13} />}
          <span>{copyLabel}</span>
        </button>
      </div>
      <pre {...props} className="md-code">{children}</pre>
    </div>
  );
}

function MarkdownLink({ href, children, node: _node, ...props }: MarkdownElementProps<"a">): ReactElement {
  const externalUrl = normalizeExternalLink(href);
  if (!externalUrl) return <span className="md-link-disabled">{children}</span>;
  const safeUrl = externalUrl;

  function openExternally(event: MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault();
    void window.sessionSearch.openExternalLink(safeUrl);
  }

  return (
    <a
      {...props}
      href={safeUrl}
      className="md-link"
      rel="noopener noreferrer"
      onClick={openExternally}
      onAuxClick={(event) => event.preventDefault()}
    >
      {children}
    </a>
  );
}

function markdownComponents(language: LanguageMode): Components {
  return {
    h1: ({ node: _node, ...props }) => <h1 {...props} className="md-h md-h1" />,
    h2: ({ node: _node, ...props }) => <h2 {...props} className="md-h md-h2" />,
    h3: ({ node: _node, ...props }) => <h3 {...props} className="md-h md-h3" />,
    h4: ({ node: _node, ...props }) => <h4 {...props} className="md-h md-h4" />,
    h5: ({ node: _node, ...props }) => <h5 {...props} className="md-h md-h5" />,
    h6: ({ node: _node, ...props }) => <h6 {...props} className="md-h md-h6" />,
    p: ({ node: _node, ...props }) => <p {...props} className="md-p" />,
    ul: ({ node: _node, className, ...props }) => <ul {...props} className={`md-ul ${className ?? ""}`.trim()} />,
    ol: ({ node: _node, className, ...props }) => <ol {...props} className={`md-ol ${className ?? ""}`.trim()} />,
    hr: ({ node: _node, ...props }) => <hr {...props} className="md-hr" />,
    blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="md-blockquote" />,
    code: ({ node: _node, className, ...props }) => <code {...props} className={className} />,
    pre: (props) => <MarkdownCodeBlock {...props} language={language} />,
    a: MarkdownLink,
    table: ({ node: _node, ...props }) => <div className="md-table-wrap"><table {...props} className="md-table" /></div>,
    img: ({ alt, node: _node }) => <span className="md-image-placeholder">[{alt || localize(language, "Image", "图片")}]</span>,
  };
}

export function Markdown({ text, language }: { text: string; language: LanguageMode }): ReactElement {
  const components = useMemo(() => markdownComponents(language), [language]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
