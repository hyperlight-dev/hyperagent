---
name: file-generation
description: Build binary files (ZIP, PPTX, PDF, DOCX) and write to disk
modules: [zip-format, ziplib, pptx, pdf, pdf-charts]
plugins: [fs-write]
profiles: [file-builder]
heapMb: 128
scratchMb: 128
cpuTimeoutMs: 15000
wallTimeoutMs: 60000
---

1. Enable fs-write plugin (fs-read auto-enables as companion)
2. For TEXT output (Markdown, CSV, JSON, plain text): use write_output(path, content) directly
3. For BINARY output (PPTX, ZIP, DOCX): build in the sandbox using ha:zip-format / ha:pptx
4. Write binary output using the fs-write plugin — accepts Uint8Array directly
5. No base64 encoding needed — pass binary data throughout
6. Maximum 1MB per write call, up to 10MB per file via multiple calls
7. For PPTX: use ha:pptx to build slides, then build the ZIP output
8. For PDF: use ha:pdf to build pages with addContent(), then exportToFile()
9. Binary data (images, charts) should be Uint8Array throughout — no string conversion
