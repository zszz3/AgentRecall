# Disable AI summaries for CodeWiz sessions

## Scope

AgentRecall must never generate AI summaries for sessions whose source is `codewiz-cli`. Existing stored summaries remain visible and are not deleted. All other session sources keep their current behavior.

## Design

- Define the source-level eligibility rule in the session-source domain module.
- Exclude `codewiz-cli` in both V1 SQLite and V2 PostgreSQL missing-summary queries so automatic and batch backfills do not select those sessions or let them consume batch limits.
- Enforce the same rule in the single-session summary operation so manual and future callers cannot bypass it.
- Hide the manual summary action for CodeWiz sessions while continuing to display any existing summary.

## Verification

- V1 and V2 repository tests prove CodeWiz is excluded while an eligible session remains selected.
- Source-rule tests prove only `codewiz-cli` is ineligible.
- V1 and V2 renderer tests prove the manual summary action is absent for CodeWiz.
- Focused tests and both-app typechecking must pass.
