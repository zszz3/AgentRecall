import { FileInput } from "lucide-react";
import type { RegisteredArtifact } from "../../../../shared/types";
import { Markdown } from "../../Markdown";

export interface WorkflowOutputDocument {
  title: string;
  path: string;
}

export function WorkflowOutputsPanel({
  finalReport,
  artifacts,
  documents,
  loadingPath,
  error,
  text,
  onOpenDocument,
}: {
  finalReport: string;
  artifacts: RegisteredArtifact[];
  documents: WorkflowOutputDocument[];
  loadingPath: string | undefined;
  error: string | undefined;
  text: {
    finalReport: string;
    completed: string;
    registeredArtifacts: string;
    outputDocuments: string;
    files: string;
    loading: string;
  };
  onOpenDocument: (path: string) => Promise<void>;
}) {
  return <>
    {finalReport.trim() ? (
      <section className="workflow-final-report" aria-label="Workflow final report">
        <div className="workflow-final-report-head"><strong>{text.finalReport}</strong><span>{text.completed}</span></div>
        <div className="workflow-final-report-body"><Markdown text={finalReport} /></div>
      </section>
    ) : null}
    {artifacts.length > 0 ? (
      <section className="workflow-output-documents" aria-label="Registered artifacts">
        <div className="workflow-output-documents-head"><strong>{text.registeredArtifacts}</strong><span>{`${artifacts.length} ${text.files}`}</span></div>
        <div className="workflow-output-document-list">
          {artifacts.map((artifact) => artifact.kind === "file" && artifact.path ? (
            <button key={artifact.id} className="workflow-output-document" onClick={() => void onOpenDocument(artifact.path!)} disabled={loadingPath === artifact.path} title={artifact.description || artifact.path}>
              <FileInput size={14} /><span>{artifact.title}</span><small>{artifact.description || artifact.path}</small>
            </button>
          ) : artifact.kind === "url" && artifact.url ? (
            <a key={artifact.id} className="workflow-output-document" href={artifact.url} target="_blank" rel="noreferrer" title={artifact.description || artifact.url}>
              <FileInput size={14} /><span>{artifact.title}</span><small>{artifact.description || artifact.url}</small>
            </a>
          ) : (
            <div key={artifact.id} className="workflow-output-document" title={artifact.description || artifact.title}>
              <FileInput size={14} /><span>{artifact.title}</span>{artifact.description ? <small>{artifact.description}</small> : null}
            </div>
          ))}
        </div>
      </section>
    ) : null}
    {documents.length > 0 ? (
      <section className="workflow-output-documents" aria-label="Workflow output documents">
        <div className="workflow-output-documents-head"><strong>{text.outputDocuments}</strong><span>{`${documents.length} ${text.files}`}</span></div>
        <div className="workflow-output-document-list">
          {documents.map((document) => (
            <button key={document.path} className="workflow-output-document" onClick={() => void onOpenDocument(document.path)} disabled={loadingPath === document.path} title={document.path}>
              <FileInput size={14} /><span>{document.title}</span><small>{loadingPath === document.path ? text.loading : document.path}</small>
            </button>
          ))}
        </div>
        {error ? <div className="workflow-error">{error}</div> : null}
      </section>
    ) : null}
  </>;
}
