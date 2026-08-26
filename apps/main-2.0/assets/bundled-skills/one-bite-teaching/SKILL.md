---
name: one-bite-teaching
description: First dig out what actually matters in a project or system from real sources, then teach it one small point at a time, pausing for confirmation after each. Use when the user wants to genuinely understand a codebase/system (not get a summary), is preparing to explain their own work (e.g. interview prep on a resume), says "教我 / 一点一点讲 / 别一次说太多", or keeps replying "没听懂 / 啥意思" to long explanations.
---

# One-Bite Teaching

Teach so the learner can later explain it themselves, out loud, without notes. This is a two-phase skill: **first find the key points from real sources, then deliver them one bite at a time.** Skipping phase one produces confident, well-formatted teaching of things that are wrong or not actually central — the worst outcome.

## Phase 1 — Find the key points first (before teaching anything)

You cannot teach the essence of a project you have only skimmed. Extract it from real sources first:

1. **Map before you drill.** Get the shape — modules, entry points, the main flow, input→output — before opening any single file deeply. Hold a one-paragraph "what is this" before going deep on any part.
2. **Find the load-bearing designs, not a feature list.** The essence is the few decisions everything hinges on and the WHY behind them (the trade-off, the failure mode they prevent). Rank candidates by "if this were wrong, how much breaks." A feature inventory is not understanding.
3. **Mine comments and docs for the "why" and the evidence.** The highest-signal spots are where the code deliberately does NOT do the obvious thing and a comment says why — often with measured rationale (a threshold, an "X of Y cases" number, a calibration note). Those explain why a value is what it is.
4. **Verify every claim against the real source; separate confirmed from inferred.** Read the actual code / doc / git history / chat, don't reason from the name. Never smooth a gap with a plausible guess — the learner may repeat it under questioning. Label inference as inference.
5. **Numbers need provenance and a denominator.** A metric isn't learned until you know where it came from and what it's over (4/736, not just "0.5%"). Trace it to its source doc/run.
6. **Attribute ownership honestly.** In shared projects, use git/doc authorship to separate what the learner did from what the team did. Don't let them absorb others' work — it collapses under one follow-up.
7. **Hunt the pitfalls and counter-intuitive parts.** The traps and the "we deliberately don't do X because…" decisions are the highest-value things to understand and the most likely to be asked about.

Output of phase 1: a ranked short list of points that actually matter, each with its evidence and source. THEN teach.

## Phase 2 — Deliver one bite at a time

1. Give exactly ONE point per turn. A "point" = a single idea the learner can hold at once — a definition, one design decision, one pitfall, one number and what it means.
2. Stop and check: end with a short "清楚了吗?" and WAIT. Do not pre-answer, do not chain into the next point.
3. Let the reply steer the next bite: "懂了/继续" → next point; "没听懂/啥意思" → re-teach the SAME point a different way (usually a concrete example), don't advance; a question → answer just that, then resume.
4. Keep a running progress map so the learner sees where they are and what's left.

## The two rules that fight each other — hold both

- **Small.** One point per turn. If you're about to emit three headers, stop at the first. Long answers don't land — that's why the user asked for this.
- **But never hide the key point.** Small ≠ shallow. Cutting a chunk into pieces is right; cutting the load-bearing insight OUT to look short is the opposite failure, and the user will call it ("你不能隐藏关键点"). Each bite is small AND complete: the one point plus the one reason it matters. When these conflict, split into more turns — don't drop the insight.

## How to explain

- Structure a mechanism as **"问题是什么 → 怎么解决"**, one step per line, each step one sentence. Reveal the problem before the fix.
- Put the answer WITH the question. If you pose a checking question, give the answer right under it — don't quiz-and-wait unless the user asked to be quizzed. ("你别问我答案了，你在问题后面给出答案。")
- When something doesn't land, switch to a **concrete example** — a real number, a real page, a real error string. Re-explaining the same abstraction louder never works.
- Prefer plain words over internal jargon. If a term is internal shorthand (an internal code name or metric label), translate it or flag it — don't make the learner memorize a word they can't use elsewhere.

## Interview-prep mode

When the learner is preparing to defend their own work (resume walkthrough, design review, oral exam):

- After a concept lands, offer a **"面试这样答"** card: a spoken-length model answer (a real answer is 45–90 seconds, not one line), first-person, that packages the point into something defensible.
- Name the likely follow-up probe and what it tests, so they see the question tree, not just the current node.
- Guard honesty hard. Separate what they did from what the team did; flag claims a number won't support; give the graceful way to concede a gap ("this part was X's; the principle I know is…") instead of bluffing. A confident wrong answer is worse than an honest boundary. If a metric can't be sourced, coach the honest version rather than inventing support.

## Anti-patterns

- Teaching before you've actually found the key points from real sources.
- Emitting a multi-section overview when the user said "别一次说太多". A table of contents is not a bite.
- Advancing while the user is still confused — confusion means re-teach, not proceed.
- Ending with "要不要我继续讲 A、B、C 和 D?" — offer the next single step, not a four-item menu.
- Quizzing the user when they didn't ask to be quizzed.
- Dropping the hard part to keep it short.
