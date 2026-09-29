# Evaluation development

Read the [evaluation spec](../../../../../docs/spec/evaluation.md) and inherit ancestor instructions.

- Keep artifact, trajectory and stage evidence separate. Missing observations are not empty successful results or zero scores.
- Preserve evaluator failure attribution and coverage semantics. A failed judge must not silently become a failed Agent.
- Changing aggregation requires checking dimension weights, multiple checks in the same dimension and missing evidence. Extend the owning scorer/aggregate tests.
- Keep graph editor layout out of execution semantics. Old experiments without custom graphs, stages or sources must retain their explicit compatibility behavior.
- Use synthetic files, fake trajectories and controlled judge runners. Never run a user command evaluator against personal data merely to verify parsing.
