---
name: report-builder
description: Generate documents, reports, and formatted output files
triggers:
  - report
  - document
  - DOCX
  - markdown
  - generate
  - summary
  - output
  - write
  - create file
patterns:
  - two-handler-pipeline
  - file-generation
antiPatterns:
  - Don't build the entire report in one monolithic handler
  - Don't inline large template strings — keep handlers under 4KB
  - Don't forget to enable fs-write plugin before writing files
allowed-tools:
  - register_handler
  - execute_javascript
  - delete_handler
  - get_handler_source
  - edit_handler
  - list_handlers
  - reset_sandbox
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - list_mcp_servers
  - mcp_server_info
  - manage_mcp
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - register_module
  - write_output
  - read_input
  - read_output
  - ask_user
---

## Report Building Guidance

For TEXT reports (Markdown, plain text, CSV, JSON):

- Use write_output(path, content) directly — no sandbox needed
- Build the content as a string in the LLM context
- write_output requires fs-write plugin to be enabled

For binary formats (DOCX, PPTX, XLSX, ZIP):

- Use the sandbox with ha:zip-format, ha:pptx, or ha:xlsx
- Apply file-builder profile for generous heap/scratch limits
- Write binary output via fs-write plugin from the handler

For multi-section reports:

- Build sections as strings, concatenate, then write_output
- Or use event dispatch in sandbox for complex transformations
- Use ha:shared-state if data needs to survive handler recompiles

For reading input files:

- Use read_input(path) directly — no sandbox needed
- Requires fs-read plugin to be enabled

Always apply the file-builder profile before building binary files.
