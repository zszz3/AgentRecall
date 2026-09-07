---
name: frontend-design
description: Use when building or substantially reshaping a user interface, page, website, dashboard, or interactive frontend.
---

# Frontend Design

Create interfaces with a clear point of view instead of assembling familiar defaults.

## Before coding

1. Read the existing product and design conventions. Preserve an established system unless the task explicitly calls for a redesign.
2. Name the audience, the screen's primary job, and one visual idea rooted in the product's subject matter.
3. Define a compact system: 4-6 colors, type roles, spacing rhythm, layout constraints, and one signature element.
4. Reject choices that could be pasted unchanged into an unrelated product.

## Build

- Make the real usable screen first, not a marketing page about the feature.
- Match information density to the domain. Operational tools favor scanning, comparison, and repeated action.
- Use established components and icon libraries already present in the repository.
- Keep sections unframed unless an item genuinely needs a card. Do not nest cards.
- Use responsive constraints for boards, toolbars, grids, and controls so content cannot resize or overlap them.
- Treat copy as interface material: concrete labels, active commands, actionable errors, and useful empty states.
- Respect keyboard focus, reduced motion, contrast, and mobile layouts.

## Visual discipline

Spend visual emphasis in one place. Avoid decorative gradients, floating blobs, arbitrary oversized headings, and a palette dominated by one fashionable hue. Typography, spacing, and hierarchy should carry most of the design.

## Verify

Run the application and inspect screenshots at desktop and mobile sizes. Exercise primary interactions, long labels, loading, empty, error, and selected states. Fix clipping, overlap, blank canvases, unintended layout shifts, and inaccessible controls before reporting completion.

## Output

Deliver working code consistent with the repository, then report the implemented behavior and verification performed. Do not narrate obvious visual features inside the product UI.
