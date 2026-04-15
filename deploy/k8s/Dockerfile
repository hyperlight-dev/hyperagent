# HyperAgent K8s image
# Extends the base Dockerfile with a wrapper entrypoint that
# copies output files to /output/ for kubectl cp retrieval.
#
# Build: docker build -f deploy/k8s/Dockerfile -t hyperagent-k8s .

FROM hyperagent:latest

# Create predictable output directory
USER root
RUN mkdir -p /output && chown hyperagent:hyperagent /output

# Add the K8s entrypoint wrapper
COPY deploy/k8s/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER hyperagent

ENTRYPOINT ["/app/entrypoint.sh"]
