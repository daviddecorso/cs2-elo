# Design system

Every page uses the flat look: text on the page background, no boxes. Build page chrome from the primitives in `ui.tsx` and `DataTable.tsx` instead of writing classes inline.

## Primitives

- `PageHeader`: the page's bare `h1`, with optional `subtitle`, `eyebrow` and `actions`.
- `Section`: a titled block. The title is plain text with a bottom rule, and the body has no box or padding.
- `Toolbar`: filter/control row above the content it controls. Sits 16px from the header above and the content below instead of the page's section gap.
- `Card`: a boxed surface (`bg-surface border`). Only for popovers, tooltips, the modal shell, deck cards and bracket matchups.
- `Inset`: a tinted `bg-surface-2` box for a callout inside a Card or Section.
- `Label`: the uppercase mono label. It is the only place the label classes live, so never inline the label string.
- `StatTile`: a label, big value and caption, with no box.
- `EmptyState`: centered muted text for empty or error states.
- `Badge`: a small tag, with `tone` of `neutral`, `up`, `down`, `heat` or `accent`.
- `Tooltip`: interactive viewport-clamped tooltip rendered inside a portal `Card`.
- `Modal`: accessible keyboard-trapped modal dialog.
- `DataTable`, `TableHead`, `Th`, `SortHeader`, `Row`, `Td`, `ProbabilityBar`, `FactorBar`: every table. Don't hand-roll `<table>` or local `TH`/`TD` constants.

## Choosing a container

Reach for `Section` first. Use `Card` only when the element floats above the page or needs its own surface, and `Inset` for a callout nested inside either. Tables inside a `Card` or `Inset` pick up that surface through `--table-bg`.
