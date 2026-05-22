---
name: dynamo-bug
description: File a GitHub bug issue against ai-dynamo/dynamo using context from the current conversation — auto-collects environment info (OS, CUDA, GPU, Python, k8s/helm chart) and assembles a complete bug template. Use whenever the user says "file a bug", "open a Dynamo issue", "report this as a Dynamo bug", "create a GitHub issue for this", or otherwise wants to capture the current investigation as a public bug report on ai-dynamo/dynamo (typically after the debug-session workflow has narrowed down the issue).
user-invocable: true
---

# File a Dynamo Bug Issue

> **Related skills:** `debug-session` (set up a worklog and investigation before filing), `dynamo-docs` (update Dynamo Fern docs with workarounds once the bug is understood).

Use the current conversation context to file a well-structured bug report against `ai-dynamo/dynamo` via the `gh` CLI.

## Instructions

1. **Gather context from the conversation.** Review what the user has been working on, the problem encountered, error messages, logs, stack traces, and any reproduction steps already discussed. If critical details are missing, ask the user briefly — but prefer inferring from conversation context over asking.

2. **Collect environment info.** First determine deployment type from the conversation; then gather the relevant details.

   **Detect deployment type by keyword scan of the conversation:**
   - Keywords pointing to **Kubernetes**: `kubectl`, `helm`, `pod`, `manifest`, `namespace`, `EKS`, `GKE`, `kind`, `helmfile`, `kustomize`, `daemonset`, image-tag references in YAML
   - Keywords pointing to **local**: `python -m`, `pip install`, `./launch`, `uv run`, local file paths (`~/`, `/home/`), `cargo run`, `maturin develop`
   - If both surfaces appear, ask the user one targeted question rather than guessing.

   **Field collection per type:**

   For **Kubernetes** environments:
   - K8s version / distribution (e.g., EKS, GKE, kind)
   - Dynamo runtime version / container image tag
   - Node OS and CPU architecture
   - CUDA version and GPU architecture (if applicable)
   - Python version (if applicable)
   - Helm chart version or manifest details

   For **local development** environments:
   - OS and version
   - Dynamo runtime version
   - CPU architecture
   - CUDA version and GPU architecture (if applicable)
   - Python version

   **Precedence rule**: if the user has already stated a value (e.g. "we're on CUDA 12.4, Python 3.11, dynamo 0.3.0"), use their values **verbatim**. Only auto-detect fields the user did NOT provide. Don't burn tool calls reconfirming what's already authoritative.

   Useful detection commands when needed: `uname -a`, `python3 --version`, `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`, `nvcc --version`, `kubectl version --short`. Mark genuinely unknown fields as "N/A".

   **Ask-if-missing checklist** (for fields critical to triage that you can't infer):
   - Exact reproduction command or manifest path
   - Measured-vs-expected metric (for perf/throughput bugs)
   - Relevant logs / stack trace (paste or path)
   - Bisect status — is there a last-known-good release tag?

3. **Construct the title.** Pattern: `[<backend or component>] <one-line symptom> (<key env>)`. Examples:
   - `[trtllm] 30% throughput drop on disagg launch (H100, dynamo 0.3.0)`
   - `[k8s/router] KV-aware router panics on empty cluster manifest`

   Constraints: ≤ 90 chars, lower-case-friendly, no emoji, no internal ticket IDs (Linear/etc. go in the body).

4. **Draft the issue** using this template and present it to the user for review before filing:

   ```
   **Describe the Bug**
   <clear, concise description>

   **Steps to Reproduce**
   1. ...
   2. ...
   <!-- Include relevant manifests or public container references if applicable -->

   **Expected Behavior**
   <what should have happened>

   **Actual Behavior**
   <what actually happened — include error messages, logs, or stack traces>

   **Environment**
   - **OS:** ...
   - **Dynamo Runtime Version:** ...
   - **CPU Architecture:** ...
   - **CUDA Version:** ...
   - **GPU Architecture:** ...
   - **Python Version:** ...
   <!-- Add K8s-specific fields if applicable -->
   ```

5. **Show the draft to the user** and ask for confirmation or edits before filing. **Do not run `gh issue create` until the user has explicitly replied affirmatively** to the draft. Treat silence as not-yet-confirmed — re-prompt rather than file.

6. **File the issue** using a HEREDOC for the body and the `bug` label for triage:

   ```bash
   gh issue create --repo ai-dynamo/dynamo \
     --title "<title>" \
     --label "bug" \
     --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```

7. **Return the issue URL** to the user after creation.
