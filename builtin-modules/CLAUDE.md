# Builtin Modules Directory

Modules that run inside the Hyperlight sandbox, available to guest JavaScript via `require("ha:<module>")`.

## Rules

- **Source files** — Edit only `src/*.ts` files
- **Generated files** — `*.js` and `*.d.ts` in the root are auto-generated
- **Regenerate** — Run `npm run build:modules` after editing source
- **Enforced by** — `tests/dts-sync.test.ts` compares compiled output to committed files

## Module Header Format

Each module should have a standard header comment:

```typescript
// @module <name>
// @description <description>
// @created <ISO date>
// @modified <ISO date>
// @mutable false
// @author system
```

## Current Modules

| Module         | Purpose                             |
| -------------- | ----------------------------------- |
| `base64`       | Base64 encode/decode for Uint8Array |
| `crc32`        | CRC32 checksum calculation          |
| `xml-escape`   | XML entity escaping                 |
| `zip-format`   | ZIP file creation                   |
| `str-bytes`    | String/bytes conversion             |
| `ooxml-core`   | Core OOXML utilities                |
| `pptx`         | PowerPoint generation               |
| `pptx-charts`  | Chart support for PPTX              |
| `pptx-tables`  | Table support for PPTX              |
| `xlsx`         | Excel workbook generation           |
| `shared-state` | Cross-handler state management      |

## Workflow

1. Edit `src/<module>.ts`
2. Run `npm run build:modules`
3. Commit both source and generated files
4. Test via `just test`
