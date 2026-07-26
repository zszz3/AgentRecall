import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LanguageFn } from "highlight.js";

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  bash: "bash",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  css: "css",
  html: "xml",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  markdown: "markdown",
  md: "markdown",
  py: "python",
  python: "python",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

type LanguageModule = { default: LanguageFn };
type LanguageLoader = () => Promise<LanguageModule>;

// Each supported grammar is a separate async chunk. Importing highlight.js/lib/core
// keeps the full language catalogue out of the renderer's initial bundle.
const LANGUAGE_LOADERS: Readonly<Record<string, LanguageLoader>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const registeredLanguages = new Set<string>();

async function highlightCode(code: string, requestedLanguage: string): Promise<string | null> {
  const language = LANGUAGE_ALIASES[requestedLanguage.toLocaleLowerCase()];
  const loadLanguage = language ? LANGUAGE_LOADERS[language] : undefined;
  if (!language || !loadLanguage) return null;

  const [{ default: highlighter }, languageModule] = await Promise.all([
    import("highlight.js/lib/core"),
    loadLanguage(),
  ]);
  if (!registeredLanguages.has(language)) {
    highlighter.registerLanguage(language, languageModule.default);
    registeredLanguages.add(language);
  }
  return highlighter.highlight(code, { language, ignoreIllegals: true }).value;
}

function codeLanguage(className: string | undefined): string {
  return className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "";
}

function codeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("")
    .replace(/\n$/, "");
}

function HighlightedCodeV1({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}): ReactElement {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    if (!language) return () => {
      active = false;
    };

    void highlightCode(code, language)
      .then((result) => {
        if (active) setHighlighted(result);
      })
      .catch(() => {
        // An unavailable grammar must never prevent the transcript from rendering.
      });
    return () => {
      active = false;
    };
  }, [code, language]);

  return (
    <pre className="ar-v1-markdown__code-block" data-language={language || undefined}>
      {highlighted === null ? (
        <code className={className}>{code}</code>
      ) : (
        // This HTML is generated from escaped source by highlight.js, not from
        // Markdown raw HTML. Markdown itself is parsed with skipHtml below.
        <code className={`hljs ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      )}
    </pre>
  );
}

function MarkdownPreV1({ children }: ComponentPropsWithoutRef<"pre">): ReactElement {
  const child = Children.only(children);
  if (!isValidElement<ComponentPropsWithoutRef<"code">>(child)) {
    return <pre className="ar-v1-markdown__code-block">{children}</pre>;
  }
  const language = codeLanguage(child.props.className);
  return (
    <HighlightedCodeV1
      className={child.props.className}
      code={codeText(child.props.children)}
      language={language}
    />
  );
}

function isAllowedImageSource(src: string, allowExternalImages: boolean): boolean {
  const candidate = src.trim();
  if (!candidate) return false;
  if (
    candidate.startsWith("//")
    || candidate.startsWith("\\\\")
    || candidate.startsWith("/")
    || candidate.startsWith("./")
    || candidate.startsWith("../")
    || /^[a-z]:[/\\]/i.test(candidate)
  ) {
    return false;
  }
  const scheme = candidate.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLocaleLowerCase();
  if (scheme === "blob" || scheme === "data") return true;
  if (scheme === "file") return false;
  return allowExternalImages && (scheme === "http" || scheme === "https");
}

function MarkdownImageV1({
  allowExternalImages,
  alt,
  src,
  ...props
}: ComponentPropsWithoutRef<"img"> & { allowExternalImages: boolean }): ReactElement {
  const source = typeof src === "string" ? src : "";
  if (!isAllowedImageSource(source, allowExternalImages)) {
    return (
      <span
        aria-label={alt ? `External image blocked: ${alt}` : "External image blocked"}
        className="ar-v1-markdown__blocked-image"
        role="img"
      >
        {alt ? `[Image blocked: ${alt}]` : "[External image blocked]"}
      </span>
    );
  }
  return <img {...props} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" src={source} />;
}

function MarkdownLinkV1({ children, href, ...props }: ComponentPropsWithoutRef<"a">): ReactElement {
  const external = typeof href === "string" && /^(?:https?:)?\/\//i.test(href);
  return (
    <a
      {...props}
      href={href}
      rel={external ? "noreferrer noopener" : props.rel}
      target={external ? "_blank" : props.target}
    >
      {children}
    </a>
  );
}

export interface MarkdownV1Props {
  children?: string;
  className?: string;
  /**
   * HTTP(S) images are replaced with a text placeholder unless the host
   * explicitly opts in. Local paths, file URLs, and UNC resources stay blocked.
   */
  allowExternalImages?: boolean;
}

/**
 * GFM Markdown for session transcripts. Raw HTML is always discarded.
 */
export function MarkdownV1({
  allowExternalImages = false,
  children,
  className = "",
}: MarkdownV1Props): ReactElement {
  return (
    <div className={`ar-v1-markdown ${className}`.trim()}>
      <ReactMarkdown
        components={{
          a: MarkdownLinkV1,
          code: ({ children: codeChildren, className: codeClassName, ...props }) => (
            <code {...props} className={codeClassName}>
              {codeChildren}
            </code>
          ),
          img: (props) => <MarkdownImageV1 {...props} allowExternalImages={allowExternalImages} />,
          pre: MarkdownPreV1,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
