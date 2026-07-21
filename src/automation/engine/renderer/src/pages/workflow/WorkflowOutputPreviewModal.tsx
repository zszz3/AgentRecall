import { X } from "lucide-react";
import type { LocalFilePreview } from "../../../../shared/types";
import { MarkdownDocument } from "../../ui/MarkdownDocument";
import { isMarkdownFilePath } from "./workflow-utils";

export function WorkflowOutputPreviewModal({
  preview,
  closeLabel,
  truncatedLabel,
  onClose,
}: {
  preview: LocalFilePreview;
  closeLabel: string;
  truncatedLabel: string;
  onClose: () => void;
}) {
  return (
    <section className="workflow-file-preview-overlay" role="dialog" aria-modal="true" aria-label="Workflow output document preview" onClick={onClose}>
      <article className="workflow-file-preview-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>{preview.title}</strong>
            <span>{preview.path}</span>
          </div>
          <button className="icon-btn" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
            <X size={15} />
          </button>
        </header>
        {preview.truncated ? <div className="workflow-file-preview-note">{truncatedLabel}</div> : null}
        <div className="workflow-file-preview-content">
          {/\.html?$/i.test(preview.path) ? (
            <iframe className="workflow-file-preview-frame" title={preview.title} sandbox="" srcDoc={preview.content} />
          ) : isMarkdownFilePath(preview.path) ? (
            <MarkdownDocument className="workflow-file-preview-body" text={preview.content} />
          ) : (
            <pre>{preview.content}</pre>
          )}
        </div>
      </article>
    </section>
  );
}
