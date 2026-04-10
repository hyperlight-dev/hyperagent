#!/usr/bin/env bash
# ── run-pdf-prompts.sh ────────────────────────────────────────────────
#
# Run PDF generation prompts through HyperAgent and collect results.
# Works locally AND in CI (1ES KVM runners).
#
# Usage:
#   ./scripts/run-pdf-prompts.sh                    # Run all prompts
#   ./scripts/run-pdf-prompts.sh invoice.yaml       # Run single prompt
#   ./scripts/run-pdf-prompts.sh "*.yaml"           # Glob pattern
#
# Output directory: /tmp/hyperagent-pdf-tests/<timestamp>/
#   <name>/
#     prompt.yaml          — Original prompt file
#     result.json          — Handler return value (includes LLM feedback)
#     transcript.log       — Full conversation transcript
#     code.log             — Generated handler code
#     debug.log            — Debug/verbose output
#     output.pdf           — Generated PDF (if found)
#     validation.json      — PDF structural validation results
#     summary.txt          — Human-readable summary
#
# Exit codes:
#   0 — All prompts generated PDFs successfully
#   1 — One or more prompts failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPTS_DIR="$ROOT/tests/pdf-prompts"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_BASE="/tmp/hyperagent-pdf-tests/$TIMESTAMP"

# Which prompts to run
PATTERN="${1:-*.yaml}"

# Ensure GITHUB_TOKEN is available and exported
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  if command -v gh &>/dev/null; then
    GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "❌ GITHUB_TOKEN not set and gh CLI not authenticated."
  echo "   Set GITHUB_TOKEN or run: gh auth login"
  exit 1
fi
export GITHUB_TOKEN

# Ensure qpdf is available — required for PDF structural validation.
# Install with: sudo apt-get install -y qpdf
if ! command -v qpdf &>/dev/null; then
  echo "❌ qpdf is not installed. PDF structural validation requires it."
  echo "   Install: sudo apt-get install -y qpdf"
  echo "   (On macOS: brew install qpdf)"
  exit 1
fi

# Ensure pdftoppm is available — required for rendering PDFs to PNG for visual inspection.
# Install with: sudo apt-get install -y poppler-utils
if ! command -v pdftoppm &>/dev/null; then
  echo "❌ pdftoppm is not installed (poppler-utils). Visual PDF rendering requires it."
  echo "   Install: sudo apt-get install -y poppler-utils"
  echo "   (On macOS: brew install poppler)"
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  🧪 HyperAgent PDF Prompt Test Suite"
echo "  📁 Output: $OUT_BASE"
echo "  📋 Prompts: $PROMPTS_DIR/$PATTERN"
echo "═══════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$OUT_BASE"

# Counters
TOTAL=0
PASSED=0
FAILED=0
ERRORS=""

# ── Parse YAML (minimal — just key: value and multiline prompt) ──
# We avoid adding a YAML parser dependency by doing simple grep/sed.
parse_yaml_field() {
  local file="$1" field="$2"
  grep "^${field}:" "$file" | head -1 | sed "s/^${field}:[[:space:]]*//"
}

# Extract the prompt text (everything after "prompt: |" until next top-level key or EOF)
parse_yaml_prompt() {
  local file="$1"
  sed -n '/^prompt: |/,/^[a-z_]*:/{ /^prompt: |/d; /^[a-z_]*:/d; p; }' "$file" | sed 's/^  //'
}

# ── Run a single prompt ──
run_prompt() {
  local yaml_file="$1"
  local name
  name="$(parse_yaml_field "$yaml_file" "name")"

  local skill profiles timeout expected_file allowed_domains
  skill="$(parse_yaml_field "$yaml_file" "skill")"
  profiles="$(parse_yaml_field "$yaml_file" "profiles")"
  timeout="$(parse_yaml_field "$yaml_file" "timeout")"
  expected_file="$(parse_yaml_field "$yaml_file" "expected_file")"
  allowed_domains="$(parse_yaml_field "$yaml_file" "allowed_domains" 2>/dev/null || true)"

  local out_dir="$OUT_BASE/$name"
  mkdir -p "$out_dir"

  # Copy original prompt for reference
  cp "$yaml_file" "$out_dir/prompt.yaml"

  # Extract prompt text to a temp file, then append feedback instructions.
  # The feedback instructions are generic (not format-specific) and tell the LLM
  # to provide structured improvement feedback AFTER completing the main task.
  local prompt_file="$out_dir/prompt.txt"
  parse_yaml_prompt "$yaml_file" > "$prompt_file"
  local feedback_instructions="$PROMPTS_DIR/_feedback-instructions.txt"
  if [[ -f "$feedback_instructions" ]]; then
    echo "" >> "$prompt_file"
    cat "$feedback_instructions" >> "$prompt_file"
  fi

  echo "──────────────────────────────────────────────────────────────"
  echo "  📄 Running: $name"
  echo "  🎯 Skill: $skill | Profiles: $profiles | Timeout: ${timeout}s"
  echo "  📁 Output: $out_dir"
  echo ""

  # Build HyperAgent arguments
  local ARGS=(
    --auto-approve
    --skill "$skill"
    --show-code
    --verbose
    --transcript
    --debug
  )

  # Add profiles
  for p in $profiles; do
    ARGS+=(--profile "$p")
  done

  # Set plugin config for web-research prompts (allowed domains)
  if [[ -n "$allowed_domains" ]]; then
    export HYPERAGENT_PLUGIN_CONFIG_FETCH_ALLOWEDDOMAINS="$allowed_domains"
  fi

  # Run HyperAgent with timeout.
  # Uses HYPERAGENT_PROMPT env var (like gauntlet-test.sh). The prompt
  # is exported so child processes inherit it directly — no bash -c
  # quoting issues. Output goes through tee for real-time visibility.
  local start_time
  start_time="$(date +%s)"
  local exit_code=0

  export HYPERAGENT_PROMPT
  HYPERAGENT_PROMPT="$(cat "$prompt_file")"

  # Use eval + tee (same pattern as gauntlet-test.sh — proven to work).
  # No bash -c wrapper, no timeout wrapper — those break env var inheritance.
  eval "cd '$ROOT' && npx tsx src/agent/index.ts ${ARGS[*]}" 2>&1 | tee "$out_dir/debug.log" || exit_code=$?

  local end_time
  end_time="$(date +%s)"
  local duration=$((end_time - start_time))

  # Unset domain config
  unset HYPERAGENT_PLUGIN_CONFIG_FETCH_ALLOWEDDOMAINS 2>/dev/null || true

  # ── Collect outputs ──

  # Find the transcript log (most recent in ~/.hyperagent/logs/)
  local transcript_log=""
  transcript_log="$(ls -t ~/.hyperagent/logs/hyperagent-transcript-* 2>/dev/null | head -1 || true)"
  if [[ -n "$transcript_log" ]]; then
    cp "$transcript_log" "$out_dir/transcript.log" 2>/dev/null || true
  fi

  # Find the code log
  local code_log=""
  code_log="$(ls -t ~/.hyperagent/logs/hyperagent-code-* 2>/dev/null | head -1 || true)"
  if [[ -n "$code_log" ]]; then
    cp "$code_log" "$out_dir/code.log" 2>/dev/null || true
  fi

  # Find the generated PDF
  local pdf_path=""
  pdf_path="$(find /tmp/hyperlight-fs-* -name "$expected_file" -newer "$out_dir/prompt.yaml" 2>/dev/null | head -1 || true)"
  if [[ -n "$pdf_path" && -f "$pdf_path" ]]; then
    cp "$pdf_path" "$out_dir/output.pdf"
  fi

  # ── Validate PDF ──
  local valid_header="false"
  local valid_eof="false"
  local page_count=0
  local file_size=0
  local content_checks=""

  if [[ -f "$out_dir/output.pdf" ]]; then
    file_size="$(stat -c%s "$out_dir/output.pdf" 2>/dev/null || echo 0)"

    # Check PDF header
    if head -c 8 "$out_dir/output.pdf" | grep -q "%PDF-1.7"; then
      valid_header="true"
    fi

    # Check EOF marker
    if strings "$out_dir/output.pdf" | grep -q "%%EOF"; then
      valid_eof="true"
    fi

    # Count pages
    page_count="$(strings "$out_dir/output.pdf" | grep -oP '/Count \K\d+' | head -1 || echo 0)"

    # Check expected content (parse only lines between expected_content: and the next top-level key)
    local expected_content
    expected_content="$(sed -n '/^expected_content:/,/^[a-z_]*:/{
      /^expected_content:/d
      /^[a-z_]*:/d
      /^  - /p
    }' "$yaml_file" | sed 's/^  - //' || true)"
    local found=0
    local total_expected=0
    while IFS= read -r expected; do
      [[ -z "$expected" ]] && continue
      total_expected=$((total_expected + 1))
      if strings "$out_dir/output.pdf" | grep -qi "$expected"; then
        found=$((found + 1))
        content_checks="${content_checks}  ✅ Found: \"$expected\"\n"
      else
        content_checks="${content_checks}  ❌ Missing: \"$expected\"\n"
      fi
    done <<< "$expected_content"

    # qpdf structural validation (guaranteed available — checked at startup)
    local qpdf_result="fail"
    if qpdf --check "$out_dir/output.pdf" > "$out_dir/qpdf.log" 2>&1; then
      qpdf_result="pass"
    else
      content_checks="${content_checks}  ❌ qpdf --check FAILED (see $out_dir/qpdf.log)\n"
    fi

    # Render PDF pages to PNG for visual inspection (guaranteed available — checked at startup)
    pdftoppm -png -r 200 "$out_dir/output.pdf" "$out_dir/page" 2>/dev/null || true
    local png_count=0
    local png_files=""
    for png in "$out_dir"/page-*.png; do
      [[ -f "$png" ]] || continue
      png_count=$((png_count + 1))
      png_files="${png_files}  📸 ${png}\n"
    done

    # Write validation JSON
    cat > "$out_dir/validation.json" <<VALJSON
{
  "valid_header": $valid_header,
  "valid_eof": $valid_eof,
  "page_count": $page_count,
  "file_size": $file_size,
  "content_found": $found,
  "content_expected": $total_expected,
  "qpdf": "$qpdf_result",
  "png_rendered": $png_count
}
VALJSON
  fi

  # ── Extract LLM feedback from debug log ──
  # The LLM outputs feedback JSON directly in its response text (not via a handler).
  # Look for a JSON block containing "feedback" with nested objects.
  if [[ -f "$out_dir/debug.log" ]]; then
    # Extract everything between the last ```json and ``` block that contains "feedback"
    python3 -c "
import re, sys, json
text = open('$out_dir/debug.log').read()
# Find all JSON code blocks
blocks = re.findall(r'\`\`\`json\s*(\{.*?\})\s*\`\`\`', text, re.DOTALL)
for b in reversed(blocks):
    if '\"feedback\"' in b:
        try:
            parsed = json.loads(b)
            if 'feedback' in parsed:
                json.dump(parsed, open('$out_dir/feedback.json', 'w'), indent=2)
                sys.exit(0)
        except: pass
# Fallback: look for raw JSON with feedback key in the log
matches = re.findall(r'\{[^{}]*\"feedback\"[^{}]*\{[^{}]*\}[^{}]*\}', text)
if matches:
    try:
        parsed = json.loads(matches[-1])
        json.dump(parsed, open('$out_dir/feedback.json', 'w'), indent=2)
    except: pass
" 2>/dev/null || true
  fi

  # ── Determine pass/fail ──
  local status="FAIL"
  if [[ -f "$out_dir/output.pdf" && "$valid_header" == "true" && "$valid_eof" == "true" ]]; then
    status="PASS"
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    ERRORS="${ERRORS}  ❌ $name\n"
  fi
  TOTAL=$((TOTAL + 1))

  # ── Write summary ──
  cat > "$out_dir/summary.txt" <<SUMMARY
═══════════════════════════════════════════════════════════════
  Test: $name
  Status: $status
  Duration: ${duration}s
  Exit Code: $exit_code
═══════════════════════════════════════════════════════════════

PDF Validation:
  Header valid: $valid_header
  EOF valid: $valid_eof
  Page count: $page_count
  File size: ${file_size} bytes
  qpdf: $qpdf_result
$(echo -e "$content_checks")
Output Locations:
  PDF:        $out_dir/output.pdf
  Transcript: $out_dir/transcript.log
  Code:       $out_dir/code.log
  Debug:      $out_dir/debug.log
  Feedback:   $out_dir/feedback.json
  Validation: $out_dir/validation.json

Page Renders ($png_count pages):
$(echo -e "$png_files")
SUMMARY

  # Print summary to console
  if [[ "$status" == "PASS" ]]; then
    echo "  ✅ $name — PASS (${duration}s, ${page_count} pages, ${file_size} bytes, qpdf=$qpdf_result)"
  else
    echo "  ❌ $name — FAIL (${duration}s, exit=$exit_code)"
    if [[ ! -f "$out_dir/output.pdf" ]]; then
      echo "     No PDF file generated"
    fi
  fi
  echo -e "$content_checks"
  if [[ -n "$png_files" ]]; then
    echo "  📸 Rendered pages:"
    echo -e "$png_files"
  fi
  echo ""
}

# ── Main loop ──
for yaml_file in "$PROMPTS_DIR"/$PATTERN; do
  [[ -f "$yaml_file" ]] || continue
  run_prompt "$yaml_file"
done

# ── Final report ──
echo "═══════════════════════════════════════════════════════════════"
echo "  📊 RESULTS: $PASSED/$TOTAL passed, $FAILED failed"
echo "  📁 Output: $OUT_BASE"
echo "═══════════════════════════════════════════════════════════════"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "  Failed tests:"
  echo -e "$ERRORS"
  exit 1
fi

echo ""
echo "  🎉 All tests passed!"
exit 0
