---
name: test-driven-development
description: Use when implementing any feature, bug fix, refactor, or behavior change. Write a failing behavioral test first, verify the failure, then write the minimum production code needed to pass.
---

# Test-Driven Development

## Core rule

```text
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Tests written after implementation describe what was built. Tests written first define what should be built and prove that the test can catch its absence.

## Red, green, refactor

### 1. Red

Write one small test for one observable behavior.

- Use a name that states the expected result.
- Exercise real code. Mock only boundaries that cannot be used safely or deterministically.
- Prefer public behavior over private methods, internal call counts, CSS details, or implementation structure.
- Use temporary homes, prefixes, databases, and synthetic fixtures for filesystem or installation behavior.

Run only the new test. Confirm that it fails because the requested behavior is missing. A syntax error, invalid fixture, missing dependency, or unrelated crash is not a valid red state.

If the test passes immediately, it does not demonstrate the new requirement. Correct the test before writing production code.

### 2. Green

Write the smallest implementation that satisfies the failing behavior.

- Change one cause at a time.
- Do not add speculative options or unrelated cleanup.
- Do not weaken the assertion to fit the implementation.

Run the new test again and confirm it passes. Then run the nearest relevant test set to catch regressions.

### 3. Refactor

Only after green:

- Remove duplication.
- Improve names and boundaries.
- Simplify control flow.
- Keep behavior unchanged and rerun the tests.

Repeat the cycle for the next behavior.

## Bug fixes

Reproduce the original symptom in a test before changing the fix site. The test must fail for the observed reason and pass after the root cause is fixed. When practical, temporarily revert the fix once to confirm the regression test turns red again.

## Exceptions

Generated files and data-only metadata do not need artificial unit tests, but the code that loads or validates them does. Throwaway exploration must be discarded before production work begins. Ask the user before intentionally skipping test-first implementation.

## Completion check

Before calling a change complete, verify:

- Every new behavior had a witnessed red state.
- Each red state failed for the intended reason.
- Production code was written only after red.
- Focused tests and relevant regressions pass without warnings.
- Tests assert outcomes rather than the current implementation shape.
