#!/bin/bash
# K8s entrypoint wrapper for HyperAgent
#
# Runs the agent with all args, then copies any output files
# from the random temp dir to /output/ for kubectl cp retrieval.
set -e

# Run HyperAgent with all provided arguments
/app/dist/bin/hyperagent "$@"
EXIT_CODE=$?

# Copy output files from the fs-write temp dir to /output/
# The fs-write plugin creates /tmp/hyperlight-fs-<random>/
for dir in /tmp/hyperlight-fs-*; do
    if [ -d "$dir" ]; then
        cp -r "$dir"/* /output/ 2>/dev/null || true
    fi
done

# Also copy any files written directly to /tmp/ (PDFs, etc.)
for f in /tmp/*.pdf /tmp/*.pptx /tmp/*.docx /tmp/*.xlsx /tmp/*.zip; do
    if [ -f "$f" ]; then
        cp "$f" /output/ 2>/dev/null || true
    fi
done

# Report what we collected
OUTPUT_COUNT=$(find /output -type f 2>/dev/null | wc -l)
if [ "$OUTPUT_COUNT" -gt 0 ]; then
    echo ""
    echo "📦 Output files ($OUTPUT_COUNT):"
    find /output -type f -printf "  %p (%s bytes)\n" 2>/dev/null || \
        find /output -type f 2>/dev/null | while read -r f; do echo "  $f"; done
fi

# Keep container alive briefly for kubectl cp retrieval
# The k8s-run script polls for completion and copies files during this window
if [ "$OUTPUT_COUNT" -gt 0 ]; then
    echo "⏳ Waiting 60s for file retrieval (kubectl cp)..."
    sleep 60
fi

exit $EXIT_CODE
