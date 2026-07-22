import { useRef } from "react";
import { LayoutTemplate } from "lucide-react";
import {
  EVALUATOR_TEMPLATES,
  type EvaluationEvaluatorTemplate,
} from "../../../../shared/evaluation-templates";

export function EvaluatorTemplateMenu({
  zh,
  onSelect,
}: {
  zh: boolean;
  onSelect: (template: EvaluationEvaluatorTemplate) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const groups = [
    {
      id: "deterministic",
      label: zh ? "确定性评估" : "Deterministic",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "deterministic",
      ),
    },
    {
      id: "answer-quality",
      label: zh ? "回答质量" : "Answer quality",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "answer-quality",
      ),
    },
    {
      id: "grounding",
      label: zh ? "事实与上下文" : "Grounding",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "grounding",
      ),
    },
    {
      id: "instruction",
      label: zh ? "指令遵循" : "Instruction following",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "instruction",
      ),
    },
    {
      id: "safety",
      label: zh ? "安全性" : "Safety",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "safety",
      ),
    },
    {
      id: "specialized",
      label: zh ? "专项能力" : "Specialized",
      items: EVALUATOR_TEMPLATES.filter(
        (template) => template.category === "specialized",
      ),
    },
  ];

  return (
    <details className="evaluation-template-menu" ref={detailsRef}>
      <summary className="control-btn compact secondary">
        <LayoutTemplate size={13} />
        {zh ? "模板" : "Templates"}
      </summary>
      <div className="evaluation-template-popover" role="menu">
        {groups.map((group) => (
          <section key={group.id}>
            <h4>{group.label}</h4>
            {group.items.map((template) => (
              <button
                type="button"
                role="menuitem"
                key={template.id}
                onClick={() => {
                  onSelect(template);
                  detailsRef.current?.removeAttribute("open");
                }}
              >
                <strong>{template.name}</strong>
                <span>{template.description}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </details>
  );
}
