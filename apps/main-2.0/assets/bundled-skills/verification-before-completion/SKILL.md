---
name: verification-before-completion
description: Use immediately before claiming work is complete, fixed, passing, or ready to merge. Requires fresh verification evidence for every success claim.
---

# Verification Before Completion

## Core rule

```text
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

Confidence, old results, a clean-looking diff, or another agent's report are not evidence.

## Verification gate

Before saying that anything works:

1. Identify the command or observation that proves the exact claim.
2. Run the complete verification now, not from memory or an earlier turn.
3. Read the full output, exit code, failure count, and warnings.
4. Compare the evidence with the claim and the acceptance criteria.
5. If it does not prove the claim, report the actual state and remaining gap.
6. Only then state the successful result and cite the evidence.

## Evidence by claim

| Claim | Required evidence |
| --- | --- |
| Tests pass | Fresh test output with zero failures |
| Build succeeds | Fresh build command with exit code 0 |
| Bug is fixed | Original reproduction or regression test now passes |
| UI behavior works | Runtime observation of the requested interaction |
| Ready to merge | Relevant tests, build, diff review, and repository checks |
| Requirement is complete | Each acceptance criterion mapped to evidence |

A narrow test proves only its narrow behavior. Typecheck is not a build; a build is not an interaction test; a screenshot is not proof of persistence or backend behavior.

## Regression tests

For a new regression test, witness the red-green cycle. When practical, revert the fix temporarily, confirm the test fails, restore the fix, and confirm it passes.

## Reporting

- State exactly which commands ran and their results.
- Separate verified facts from unverified assumptions.
- Mention skipped checks and why they were skipped.
- Do not use “should”, “probably”, or “looks fixed” as substitutes for evidence.
