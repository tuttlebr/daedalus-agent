# NeMo Agent Toolkit CLI Reference

Complete reference for `nat` CLI commands: run, serve, eval, info, and workflow management.

---

## nat run

Runs a workflow from a config file. Alias for `nat start console`.

```bash
nat run --config_file CONFIG_FILE [OPTIONS]
```

**Options**
- `--override <KEY VALUE>`: Override config values with dot notation (for example, `--override llms.nim_llm.temperature 0.7`)
- `--input TEXT`: Single input to submit
- `--input_file FILE`: JSON file of inputs

**Examples**
```bash
nat run --config_file configs/rag_config.yml --input "What is machine learning?"
nat run --config_file configs/rag_config.yml --input_file inputs/questions.json
nat run --config_file configs/rag_config.yml --input "Hello" --override llms.nim_llm.temperature 0.5
```

**Input file format**
```json
["What is AI?", "Explain ML"]
```
Or for complex inputs:
```json
[{"query": "What is AI?", "context": "technical"}]
```

---

## nat serve

Serves a FastAPI endpoint for the workflow. Alias for `nat start fastapi`.

```bash
nat serve --config_file CONFIG_FILE [OPTIONS]
```

**Options**
- `--override <KEY VALUE>`: Override config values
- `--host TEXT`: Host to bind to
- `--port INTEGER`: Port to bind to
- `--reload BOOLEAN`: Enable auto-reload for development
- `--workers INTEGER`: Number of workers
- `--use_gunicorn BOOLEAN`: Use Gunicorn to run the FastAPI app
- `--root_path TEXT`: Root path for the API

**Examples**
```bash
nat serve --config_file configs/rag_config.yml --host 0.0.0.0 --port 8000
nat serve --config_file configs/rag_config.yml --host 0.0.0.0 --port 8000 --workers 4 --use_gunicorn true
nat serve --config_file configs/rag_config.yml --host localhost --port 8000 --reload true
```

Once served, Swagger docs are at `http://<HOST>:<PORT>/docs`.

**Common development workflow**
1. `nat validate --config_file config.yml`
2. `nat run --config_file config.yml --input "test input"`
3. `nat serve --config_file config.yml --host localhost --port 8000 --reload true`
4. Open `http://localhost:8000/docs`
5. `nat serve --config_file config.yml --host 0.0.0.0 --port 8000 --workers 4`

---

## nat eval

Evaluates a workflow with a dataset to assess accuracy and performance.

```bash
nat eval --config_file CONFIG_FILE [OPTIONS]
```

**Options**
- `--dataset FILE`: JSON file with questions and ground truth answers
- `--result_json_path TEXT`: JSON path to extract result (default: `$`)
- `--skip_workflow`: Skip execution, use provided dataset for evaluation only
- `--skip_completed_entries`: Skip entries that already have generated answers
- `--endpoint TEXT`: Use endpoint for running workflow
- `--endpoint_timeout INTEGER`: HTTP timeout in seconds (default: 300)
- `--reps INTEGER`: Repetitions for evaluation (default: 1)

**Dataset format**
```json
[
  {"question": "What is ML?", "ground_truth": "Machine learning is..."},
  {"question": "What is AI?", "ground_truth": "Artificial intelligence is...", "context": "technical"}
]
```

**Configuration file structure**
```yaml
llms:
  nim_llm:
    _type: "nim_llm"
    model: "meta/llama-3.1-8b-instruct"
    temperature: 0.7
workflow:
  _type: "simple_rag"
  llm: llms.nim_llm
evaluation:
  dataset: "data/eval_dataset.json"
  evaluators:
    - _type: "semantic_similarity"
      threshold: 0.8
  metrics:
    - "accuracy"
    - "semantic_similarity"
```

**Handling missing evaluation config**: If the config lacks an `evaluation` section, search for files named `*_eval.yml`, `eval_*.yml`, or similar in the same directory. If none are found, prompt the user for dataset path and evaluator preferences.

**`--result_json_path` usage**
```bash
nat eval --config_file config.yml --result_json_path "$.response.answer"
nat eval --config_file config.yml --result_json_path "$.response"
nat eval --config_file config.yml --result_json_path "$"  # default
```

**Common evaluation workflows**
```bash
# Initial evaluation
nat validate --config_file eval_config.yml
nat eval --config_file eval_config.yml --dataset test_data.json

# Incremental / large dataset
nat eval --config_file eval_config.yml --skip_completed_entries --reps 5

# Against running service
nat serve --config_file prod_config.yml --host 0.0.0.0 --port 8000 --workers 4
nat eval --config_file eval_config.yml --endpoint http://localhost:8000/generate --endpoint_timeout 600

# Evaluate pre-generated results
nat eval --config_file eval_config.yml --skip_workflow --dataset results_with_generated_answers.json
```

---

## nat info components

Lists locally registered NAT components.

```bash
nat info components [OPTIONS]
```

**Options**
- `-t, --types`: Filter by type: `front_end`, `function`, `tool_wrapper`, `llm_provider`, `llm_client`, `embedder_provider`, `embedder_client`, `evaluator`, `memory`, `retriever_provider`, `retriever_client`, `registry_handler`, `logging`, `tracing`, `package`
- `-q, --query TEXT`: Search query (default: "")
- `-n, --num_results INTEGER`: Number of results (default: all)
- `-f, --fields`: Fields: `all`, `package`, `version`, `component_name`, `description`, `developer_notes`
- `-o, --output_path TEXT`: Save results to file

**Examples**
```bash
nat info components
nat info components --types llm_provider
nat info components --query "milvus"
nat info components --types llm_provider --types embedder_provider
nat info components --query "rag" --num_results 10 --output_path results.json
nat info components --fields component_name --fields description
```

## nat info channels

Lists configured remote registry channels.

```bash
nat info channels [-t rest|pypi]
```

---

## nat workflow

### nat workflow create

```bash
nat workflow create WORKFLOW_NAME [--install/--no-install] [--workflow-dir TEXT] [--description TEXT]
```

Generates a valid `pyproject.toml`, `register.py`, and config file.

```bash
nat workflow create my_rag_workflow --description "Custom RAG workflow"
nat workflow create my_rag_workflow --no-install --workflow-dir ./my_workflows
```

### nat workflow reinstall

Rebuilds and reinstalls after modifying Python code, `pyproject.toml`, or adding new tools.

```bash
nat workflow reinstall my_rag_workflow
```

### nat workflow delete

```bash
nat workflow delete my_rag_workflow
```

**Common workflow**
1. `nat workflow create my_workflow --description "..."`
2. Modify `register.py` and config
3. `nat run` or `nat serve` to test
4. `nat workflow reinstall my_workflow` after code changes
5. `nat workflow delete my_workflow` when done
