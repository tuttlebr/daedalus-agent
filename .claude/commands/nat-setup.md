# NeMo Agent Toolkit Installation Guide

Step-by-step instructions for installing the NeMo Agent Toolkit from source.

---

## Prerequisites

```bash
git --version
git lfs version
uv --version
```

If any are missing:
- [Git](https://git-scm.com)
- [Git LFS](https://git-lfs.github.com)
- [uv](https://docs.astral.sh/uv/getting-started/installation)

---

## Installation Steps

### 1. Clone and initialize

```bash
cd nemo-agent-toolkit

git submodule update --init --recursive
git lfs install
git lfs fetch
git lfs pull
```

### 2. Create Python environment

```bash
uv venv --seed .venv
# or with a specific version:
uv venv --seed .venv --python 3.11

source .venv/bin/activate
```

### 3. Install

**Option A — Full (recommended for development)**
```bash
uv sync --all-groups --all-extras
```

**Option B — Core only**
```bash
uv sync
```

**Option C — Core + specific plugins**
```bash
uv sync
uv pip install -e '.[langchain]'
uv pip install -e '.[llama-index]'
uv pip install -e '.[redis]'
```

**Available plugins**: `agno`, `crewai`, `langchain`, `llama_index`, `mem0ai`, `mysql`, `opentelemetry`, `phoenix`, `ragaai`, `redis`, `s3`, `semantic_kernel`, `weave`, `zep_cloud`

**Dependency groups**: `test`, `profiling`

---

## Verification

```bash
nat --version
nat --help
```

## API Key Setup

```bash
export NVIDIA_API_KEY=<your_api_key>
# Persist:
echo 'export NVIDIA_API_KEY=<your_api_key>' >> ~/.zshrc
```

---

## Quick Test

```bash
cat << 'EOF' > workflow.yaml
functions:
   wikipedia_search:
      _type: wiki_search
      max_results: 2
llms:
   nim_llm:
      _type: nim
      model_name: meta/llama-3.1-70b-instruct
      temperature: 0.0
workflow:
   _type: react_agent
   tool_names: [wikipedia_search]
   llm_name: nim_llm
   verbose: true
   parse_agent_response_max_retries: 3
EOF

nat run --config_file workflow.yaml --input "List five subspecies of Aardvarks"
```

---

## Ready State Checklist

- [ ] `nat --version` returns version info
- [ ] `nat --help` shows command options
- [ ] `NVIDIA_API_KEY` environment variable is set
- [ ] Virtual environment is activated
- [ ] Required plugins are installed

---

## Common Issues

1. **Python version mismatch**: Use Python 3.11, 3.12, or 3.13
2. **Git LFS not installed**: Large files will not download
3. **Submodules not initialized**: Some dependencies will be missing
4. **Virtual environment not activated**: Commands may not work
5. **Missing API key**: Most workflows require `NVIDIA_API_KEY`

---

## Example One-Liners

**LangChain/LangGraph development**
```bash
git clone git@github.com:NVIDIA/NeMo-Agent-Toolkit.git nemo-agent-toolkit && cd nemo-agent-toolkit
git submodule update --init --recursive
git lfs install && git lfs fetch && git lfs pull
uv venv --seed .venv && source .venv/bin/activate
uv sync && uv pip install -e '.[langchain]'
export NVIDIA_API_KEY=<your_key>
nat --version
```

**Full development environment**
```bash
git clone git@github.com:NVIDIA/NeMo-Agent-Toolkit.git nemo-agent-toolkit && cd nemo-agent-toolkit
git submodule update --init --recursive
git lfs install && git lfs fetch && git lfs pull
uv venv --seed .venv && source .venv/bin/activate
uv sync --all-groups --all-extras
export NVIDIA_API_KEY=<your_key>
nat --version
```
