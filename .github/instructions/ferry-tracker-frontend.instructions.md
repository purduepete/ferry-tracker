---
description: "Use when changing Ferry Tracker frontend styling, layout, themes, controls, responsive behavior, accessibility, or visual browser tests. Preserves the WebPortfolio-derived design language."
applyTo: ["frontend/**/*.{tsx,css,html}", "e2e/**/*.ts"]
---

# Ferry Tracker frontend style

## Visual direction

- Treat the sibling `../webportfolio` solution as the visual reference when a local pattern does not answer a design question.
- Preserve the compact operational explorer. Keep information dense, easy to scan, and centered on terminals, routes, vessels, schedules, and vehicle space.
- Use Roboto Flex and the existing typography scale. Reserve large type for the page title; use compact headings inside panels and controls.
- Keep the square geometry. Controls, panels, menus, and table surfaces use small or zero corner radii as established in `frontend/src/styles.css`.
- Use the existing slate light, dark, and midnight themes. Add colors through the current CSS custom properties so every theme remains complete.
- Preserve the sticky navigation, compact spacing, thin borders, and restrained shadows.
- Avoid decorative cards, oversized marketing sections, ornamental gradients, floating shapes, and a palette dominated by one accent color.

## Components and controls

- Reuse existing components and classes before adding a new visual abstraction.
- Use `FilterSelect` for terminal-style selectors. Keep its custom listbox appearance, keyboard controls, focus behavior, selected checkmark, and themed scrollbar.
- Persist favorite terminal IDs in `ferry-tracker-favorite-terminals`, where array order is the display order. Set and reorder favorites on the Settings tab; the primary terminal selector shows favorites first in that saved order, then the rest alphabetically, and marks favorites with a non-interactive star.
- Use Lucide icons for familiar actions. Navbar actions are borderless, full-height icon buttons with an accessible name and tooltip.
- Use icon-only buttons for route reversal, refresh, theme, and similar familiar commands. Give each one stable dimensions so state changes do not move nearby content.
- Keep the custom thin scrollbar on the page and dropdowns. Extend the existing theme scrollbar tokens when another scrollable surface needs styling.
- Keep related sailing and vehicle-space information in one view. Do not restore a separate vehicle-space report when the schedule rows already contain it.
- Keep loaded content mounted during refreshes and route changes. Cover the active data view with a tab-shaped skeleton for at least 500 ms, fade the skeleton out over 520 ms, and start a 900 ms data fade after a 140 ms delay. The data fade must remain visible after the skeleton recedes. Do not combine a fill-mode opacity animation with the skeleton exit transition because it pins the cover opaque.

## Responsive behavior

- Support the existing widths tested in `e2e/explorer.spec.ts`: 390, 767, 768, 1024, and 1440 pixels.
- Prevent horizontal page overflow, clipped labels, overlapping controls, and text outside its container.
- Preserve route-selection actions on mobile. Reflow or rotate controls when needed; do not hide an action required to complete the workflow.
- Keep fixed-format controls and relationship nodes dimensionally stable while data loads or changes.

## Accessibility and behavior

- Preserve semantic tabs, listboxes, buttons, labels, and status text.
- Keep full keyboard operation, visible focus, Escape handling, outside-click handling, and focus return for popovers and custom selectors.
- Keep terminal and vessel IDs in internal state, API calls, keys, favorites, and Raw JSON. Do not render them in selectors, cards, sailing rows, or tables.
- Use local time for user-facing timestamps. Prefer server response metadata such as `ApiEnvelope.fetchedAt` over client-generated refresh times.
- Show each relationship vessel's `updatedAt` value as an `Updated` field in local time.
- Preserve theme preference persistence and the startup theme script that prevents a wrong-theme first frame.

## Implementation and checks

- Continue using plain CSS and the existing Lucide dependency unless the task has a concrete requirement the current stack cannot meet.
- Inspect `frontend/src/styles.css` and the nearest existing component before adding tokens, classes, or interactions.
- Add focused component tests for changed behavior and Playwright coverage for user-visible workflows.
- After a visual change, run frontend typechecking and focused tests first. Then build before Playwright because the fixture server uses the production frontend bundle.
- Confirm desktop and mobile layouts have no horizontal overflow. When canvas or rendered geometry matters, inspect the page at representative desktop and mobile widths.
