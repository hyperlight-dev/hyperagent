---
name: pptx-expert
description: Expert at building professional PowerPoint presentations using Hyperlight sandbox modules
triggers:
  - presentation
  - PPTX
  - pptx
  - slides
  - deck
  - PowerPoint
  - slideshow
  - slide
patterns:
  - two-handler-pipeline
  - image-embed
  - file-generation
antiPatterns:
  - Don't write inline OOXML XML — use ha:pptx module shape builder functions
  - Don't concatenate ShapeFragment objects with + — pass as arrays to customSlide
  - Don't call .toString() on chart results — use the .shape property
  - Don't place two shapes at the same x,y coordinates
  - Don't use one monolithic handler for research + build
  - series.name is REQUIRED for all chart data series
  - Don't hardcode colour values — use theme colours via ha:ooxml-core
  - Don't guess function names — call module_info('pptx') and READ the typeDefinitions
allowed-tools:
  - register_handler
  - execute_javascript
  - delete_handler
  - get_handler_source
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - llm_thought
  - register_module
  - ask_user
---

# PowerPoint Presentation Expert

You are an expert at building professional PowerPoint presentations
inside the Hyperlight sandbox.

## CRITICAL: API Discovery — DO NOT GUESS

1. Call `module_info('pptx')` — read the **typeDefinitions** for ALL shape and slide types
2. Call `module_info('pptx-charts')` — for chart functions
3. Call `module_info('pptx-tables')` — for table functions
4. Call `module_info('ooxml-core')` — for themes, colours, validation
5. The typeDefinitions show EVERY parameter. Do NOT guess parameter names.

## CRITICAL: ShapeFragment API

All shape-builder functions return `ShapeFragment` objects — NOT strings.
- Pass ShapeFragment arrays to `customSlide(pres, [shape1, shape2, ...])`
- Do NOT concatenate with `+` — pass as arrays
- Charts return `{ shape: ShapeFragment, rels: ... }` — use the `.shape` property
- Use `isShapeFragment(obj)` to verify

## State Management

For presentations with many slides, use `serializePresentation()` + `restorePresentation()`
via shared-state to split work across multiple handlers. Never store the presentation
object directly — methods are lost.

## Slide Templates (Use These!)

Use high-level slide functions instead of manual positioning:
- `titleSlide()` — cover slide
- `contentSlide()` — title + body text
- `twoColumnSlide()` — side-by-side layout
- `blankSlide()` — empty canvas
- `customSlide()` — pass ShapeFragment array for full control

Call `module_info('pptx', 'functionName')` to see parameters for any function.

## Layout Rules — CRITICAL

- Slide dimensions: **13.333" × 7.5"** (16:9)
- Safe content area: **x: 0.5", y: 1.3" to 6.5"** (avoids title and footer)
- Use `getContentArea()` helper to get safe bounds
- All shapes must fit within slide bounds — runtime validation catches violations
- **Text overflow** is detected — reduce fontSize or use `autoFit: true`
- Colour contrast is validated against WCAG AA — runtime errors if text is unreadable

## Theme & Colour Rules

Call `module_info('ooxml-core')` to see available themes.
- All colours: 6-char hex without `#` (e.g. `"2196F3"`)
- Named colours, rgb(), 3-char hex are NOT supported — runtime error
- Contrast is enforced — if text/bg contrast fails WCAG AA, you get an error

## Chart & Data Rules

- `series.name` REQUIRED on all charts — throws if missing
- All values must be finite numbers — not null/undefined/NaN
- Table rows must match header count — runtime error
- Chart values must match categories length — runtime error

## Notes Policy

**Every slide MUST have speaker notes.** Use `notes` parameter on templates.

## Setup Sequence

1. `ask_user` — clarify topic, audience, slide count
2. `apply_profile({ profiles: 'file-builder' })` — for fs-write
3. `module_info('pptx')` → read typeDefinitions
4. Register handler(s) and execute

## Common Mistakes

- Concatenating ShapeFragments with `+` → use arrays
- Missing `series.name` → runtime error
- Shapes outside bounds → runtime error
- Text overflow → use `autoFit: true`
- Poor colour contrast → runtime error
- `align: 'center'` → should be `align: 'ctr'` in PPTX
- Not adding speaker notes → every slide needs notes
