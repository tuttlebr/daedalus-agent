# LLM Model Summaries

All benchmarks sourced from [Artificial Analysis](https://artificialanalysis.ai/) Intelligence Index v4.0. Pricing reflects median across providers (open weights) or first-party API (proprietary).

## Comparison

| Metric | Nemotron 3 Super 120B | Claude Opus 4.6 | gpt-oss-120B | GPT-5.4 | Mercury 2 |
|---|---|---|---|---|---|
| Creator | NVIDIA | Anthropic | OpenAI | OpenAI | Inception |
| Released | Mar 2026 | Feb 2026 | Aug 2025 | Mar 2026 | Feb 2026 |
| Intelligence Index | 36 (#2/58) | 53 (#4/132) | 33 (#4/58) | 57 (#2/132) | 33 (#28/143) |
| Output Speed (t/s) | 170.2 | 48.1 | 227.3 | 82.5 | 901.4 |
| TTFT (seconds) | 0.96 | 23.35 | 0.90 | 222.48 | 4.37 |
| Input Price ($/1M) | $0.30 | $5.00 | $0.15 | $2.50 | $0.25 |
| Output Price ($/1M) | $0.75 | $25.00 | $0.60 | $15.00 | $0.75 |
| Blended Price ($/1M) | $0.41 | $10.00 | $0.26 | $5.63 | $0.38 |
| Context Window | 1M | 1M | 131K | 1M | 128K |
| Input Modality | Text | Text, Image | Text | Text, Image | Text |
| Architecture | MoE | Undisclosed | MoE (SwiGLU) | Undisclosed | Undisclosed |
| Total / Active Params | 120.6B / 12.7B | Undisclosed | 117B / 5.1B | Undisclosed | Undisclosed |
| Open Weights | Yes | No | Yes | No | No |
| License | [Nemotron Open](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) | Proprietary | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) | Proprietary | Proprietary |
| Knowledge Cutoff | N/A | N/A | May 2024 | Aug 2025 | N/A |
| Reasoning | Yes | Yes | Yes | Yes | Yes |
| API Providers | 5 | 4 | 24 | 2 | 1 |

Rankings context: open weight models are ranked within their size class (58 models). Proprietary models are ranked within their blended-price tier (132 models for >$1/1M; 143 models for $0.15-$1/1M).

---

## [NVIDIA Nemotron 3 Super 120B A12B (Reasoning)](https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b)

Second-highest intelligence among open weight medium-class models, with strong speed and reasonable pricing. Part of the Nemotron 3 family (Nano, Super, Ultra).

MoE architecture with 120.6B total parameters but only 12.7B active per token, making it efficient for high-volume workloads. Optimized for collaborative agents and use cases like IT ticket automation. Supports chain-of-thought reasoning with a 1M token context window.

Notable tradeoff: very verbose. Generated 110M tokens during Intelligence Index evaluation (median for its class is 15M). Factor this into cost estimates for production workloads.

Weights available on [Hugging Face](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16).

---

## [Claude Opus 4.6 (Adaptive Reasoning, Max Effort)](https://artificialanalysis.ai/models/claude-opus-4-6-adaptive)

Anthropic's most intelligent model. Scores 53 on the Intelligence Index, well above the 31 median for its price tier. Multimodal (text + image input).

The premium you pay is real: $10.00/1M blended tokens vs. a $0.41 blended rate for Nemotron. Evaluating Opus 4.6 on the full Intelligence Index cost $4,970. It is also the slowest model in this set at 48.1 t/s with a 23.35s TTFT.

Best suited for tasks where raw intelligence matters more than throughput or cost: financial analysis, deep research, complex document work. Not ideal for latency-sensitive or high-volume pipelines.

---

## [gpt-oss-120B (high)](https://artificialanalysis.ai/models/gpt-oss-120b)

OpenAI's first open weight model. Fastest in its class at 227.3 t/s and cheapest in this set at $0.26/1M blended. Apache 2.0 licensed, so fully permissive for commercial use.

MoE architecture with SwiGLU activations and learned attention sinks. 117B total parameters, 5.1B active per token. Supports chain-of-thought reasoning, adjustable reasoning effort, instruction following, and tool use.

Two constraints to note: the 131K context window is significantly smaller than the 1M offered by three other models in this set, and the knowledge cutoff is May 2024. Widest provider availability at 24 API providers.

---

## [GPT-5.4 (xhigh)](https://artificialanalysis.ai/models/gpt-5-4)

Highest intelligence score in this set at 57 (ranked #2 across all 132 models in its price tier). OpenAI's frontier proprietary model, combining reasoning, coding, and agentic capabilities. Multimodal (text + image input).

The TTFT of 222.48 seconds is an outlier. This reflects heavy chain-of-thought reasoning before the first answer token. Output speed after that is solid at 82.5 t/s. Plan for this latency in any integration.

Priced at $5.63/1M blended. Knowledge cutoff is August 2025. Only 2 API providers currently. Choose this when you need maximum intelligence and can tolerate latency and cost.

---

## [Mercury 2](https://artificialanalysis.ai/models/mercury-2)

The speed story. Mercury 2 from Inception Labs is the fastest model in its entire 143-model comparison class at 901.4 t/s, nearly 4x faster than the next fastest model in this document (gpt-oss-120B at 227.3 t/s). Intelligence score of 33 ties it with gpt-oss-120B.

Priced at $0.38/1M blended, it sits in the budget tier alongside Nemotron and gpt-oss. TTFT of 4.37s is reasonable for a reasoning model. Text-only input/output, 128K context window.

Like Nemotron, it is very verbose: 69M output tokens during Intelligence Index evaluation (class median: 26M). Evaluation cost was $80.43, which is cheap in absolute terms but reflects the token volume. Architecture and parameter counts are undisclosed.

Currently available through only 1 API provider, which is the main limitation. If your workload is latency-sensitive, high-throughput, and text-only, Mercury 2 is the clear front-runner on raw speed at a competitive price point. The narrow context window (128K vs. 1M for three others in this set) may constrain RAG-heavy use cases.
