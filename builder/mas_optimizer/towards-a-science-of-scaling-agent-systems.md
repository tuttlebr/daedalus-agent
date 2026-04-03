# Towards a Science of Scaling Agent Systems

**Authors:** Yubin Kim, Ken Gu, Chanwoo Park, Chunjong Park, Samuel Schmidgall, A. Ali Heydari, Yao Yan, Zhihan Zhang, Yuchen Zhuang, Yun Liu, Mark Malhotra, Paul Pu Liang, Hae Won Park, Yuzhe Yang, Xuhai Xu, Yilun Du, Shwetak Patel, Tim Althoff, Daniel McDuff, Xin Liu

**Affiliations:** Google Research, Massachusetts Institute of Technology, Google DeepMind

**arXiv:** [2512.08296v2](https://arxiv.org/abs/2512.08296v2)

## Abstract

This research establishes quantitative principles for scaling agent systems by evaluating five canonical architectures across four benchmarks and three LLM families spanning 180 configurations. The study reveals that multi-agent coordination produces highly task-dependent outcomes, ranging from +81% improvement to -70% degradation. A predictive model using empirical coordination metrics achieves R^2 = 0.524 cross-validation performance, identifying three dominant mechanisms: a tool-coordination trade-off where complex environments amplify overhead costs; capability saturation effects reducing returns above 45% baseline performance; and architecture-dependent error amplification ranging from 4.4x to 17.2x across topologies. The framework predicts optimal architectures for 87% of held-out configurations.

---

## 1 Introduction

Agents -- language model-driven systems that operate through iterative cycles of reasoning, planning, and acting, adapting their behavior based on environmental or tool-generated feedback -- have achieved remarkable performance in diverse applications, from code generation to web browsing, medical decision-making, finance, sustainability, and scientific discovery. As tasks grow in complexity and require sustained environmental interaction, the field has increasingly turned to multi-agent systems (MAS), relying on the premise that specialized collaboration consistently outperforms single-agent systems (SAS). Previous work has made positive claims about multi-agent systems, suggesting that agent collaboration follows collaborative scaling principles and that MAS consistently outperforms SAS on complex tasks. Yet, despite rapid adoption, there remains no principled quantitative framework to predict when adding agents amplifies performance and when it erodes it. This gap leaves practitioners relying on heuristics, hindering both the emergence of a science of agent systems and, critically for real-world deployment, the ability to determine when multi-agent coordination provides genuine value over simpler single-agent alternatives.

To determine when multi-agent coordination provides benefit, the authors first establish which task categories require agentic capabilities. A critical prerequisite is distinguishing between agentic and non-agentic evaluation paradigms. Expanding from the Agentic Benchmark Checklist (ABC), they characterize agentic tasks as those requiring: (i) sustained multi-step interactions with an external environment, (ii) iterative information gathering under partial observability, and (iii) adaptive strategy refinement based on environmental feedback.

These characteristics differentiate tasks like web browsing, financial trading, software engineering, and interactive planning from traditional static benchmarks -- tasks solvable through single-shot reasoning without environmental feedback, which lack external environments, are fully observed, or require identical solution strategies. This distinction matters profoundly because, while recent agentic benchmarks have emerged, multi-agent system evaluations have been conducted predominantly on non-agentic tasks, potentially providing misleading guidance about when collaboration provides value. This distinction is practically consequential: while LLMs achieve high accuracy on isolated code generation tasks, real-world deployment requires agentic capabilities -- iterative debugging, repository navigation, and adaptive strategy refinement. Multi-agent systems that show monotonic improvement with team size on static benchmarks exhibit fundamentally different scaling behavior when evaluated on tasks requiring sustained environmental interaction, where coordination overhead and error propagation dynamics dominate.

Fundamentally, this distinction reflects a trade-off between context integration and diversity. Single-agent systems maximize context integration by maintaining a unified memory stream in which all reasoning steps share full access to prior history, enabling effectively constant-time access to global context. In contrast, multi-agent systems impose intrinsic information fragmentation: while parallel agents enable diverse exploration, they incur an unavoidable coordination tax in which the global context must be compressed into inter-agent messages. This lossy communication increases synchronization overhead and cognitive load, fundamentally altering the scaling behavior of collaboration.

The underlying dynamics explain this discrepancy: on agentic tasks, coordination overhead scales with interaction depth, agents operate on progressively divergent world states, and errors cascade through execution chains rather than being corrected through voting. Recent work has identified cases where single strong models match or exceed multi-agent systems, yet the evaluation literature provides limited guidance on what factors determine collaborative success, whether semantic diversity predicts team performance, how architectural choices shape coordination costs, or whether agents can detect and correct failures in extended interactions.

The problem is further compounded by rapid progress in frontier model capabilities. As base LLMs gain extended context windows, sophisticated tool use, and improved self-reflection, the unique value proposition of multi-agent collaboration becomes unclear. The answer likely depends on task characteristics and architectural choices that remain to be systematically quantified.

Two fundamental challenges hinder progress toward principled multi-agent design. First, existing MAS evaluations compare architectures using different prompts, tools, or computational budgets, conflating architectural effects with implementation choices and precluding clean causal attribution. Second, evaluations focus exclusively on final accuracy metrics without examining process dynamics such as coordination overhead, error propagation, and information flow that determine whether collaboration succeeds or fails. Understanding team effectiveness requires knowledge of composition, coordination mechanisms, and member differentiation. Yet practitioners lack comparable empirical understanding of how these principles translate to artificial agents, leaving them without quantitative guidance for architecture selection.

To address these challenges, the researchers present a controlled evaluation establishing the principles for agent coordination. Their experimental design isolates architectural effects by controlling for implementation confounds -- maintaining identical task prompts, tools, and computational budgets across all configurations -- while systematically varying only coordination structure and model capability. They evaluate five canonical architectures: Single Agent System (SAS) and four Multi-Agent variants (Independent, Centralized, Decentralized, Hybrid) instantiated across three major LLM families (OpenAI, Google, Anthropic) spanning diverse capability levels, on four representative agentic benchmarks: (1) web browsing, (2) financial analysis, (3) game planning, and (4) realistic workplace tasks. Across N=180 controlled configurations with matched token budgets, they derive a scaling principle across tested domains quantifying how performance emerges from empirically measured coordination properties.

In contrast to prior claims that "more agents is all you need", this evaluation reveals that the effectiveness of multi-agent systems is governed by quantifiable trade-offs between architectural properties and task characteristics. The researchers establish a predictive framework using empirical coordination metrics -- efficiency, error amplification factors, message density and redundancy -- achieving cross-validated R^2=0.524 (explaining more than half of the performance variance on held-out data) without dataset-specific parameters. Critically, this framework generalizes beyond training configurations: the model correctly predicts optimal architectures for 87% of held-out task configurations, demonstrating extrapolation to unseen task structures.

Their analysis identifies three patterns. First, a tool-coordination trade-off: tool-heavy tasks suffer from multi-agent coordination overhead, with efficiency penalties compounding as environmental complexity increases. Second, a capability ceiling: tasks where single-agent performance already exceeds 45% accuracy experience negative returns from additional agents, as coordination costs exceed diminishing improvement potential. Third, architecture-dependent error amplification. Independent systems amplify errors 17.2x through unchecked error propagation, where individual mistakes cascade to the final output. Centralized coordination, however, contains this to 4.4x by enforcing validation bottlenecks that intercept errors before aggregation. Performance spans +81% relative improvement (structured financial reasoning under centralized coordination) to -70% degradation (sequential planning under independent coordination), demonstrating that architecture-task alignment, not number of agents, determines collaborative success. Importantly, optimal architectures vary systematically: decentralized coordination benefits tasks requiring parallel exploration of high-entropy search spaces, while all multi-agent variants universally degrade performance on tasks requiring sequential constraint satisfaction, where coordination overhead fragments reasoning capacity under fixed computational budgets. The researchers synthesize these findings into quantitative architecture selection rules achieving 87% prediction accuracy on held-out configurations. The underlying mechanisms driving these patterns are interpretable: the tool-coordination trade-off arises because multi-agent systems fragment the per-agent token budget, leaving insufficient capacity for complex tool orchestration; the capability ceiling reflects that coordination overhead becomes a net cost when baseline performance is already high; and architecture-dependent error amplification stems from the presence or absence of validation bottlenecks that catch errors before propagation. These mechanistic insights enable practitioners to move from architectural heuristics to principled, measurement-driven deployment decisions.

The primary contributions are:

- **Formalization of Agentic Evaluation rigor:** The researchers redefine rigorous agentic assessment by distinguishing it from static reasoning tasks. They establish that valid agentic evaluation requires three necessary conditions: sustained multi-step environment interaction, iterative information gathering under partial observability, and adaptive strategy refinement based on feedback.

- **Controlled evaluation of agent systems:** They establish a framework for comparing agent architectures, controlling for implementation confounds to isolate the effects of coordination structure. Their framework spans 180 configurations across three LLM families and four diverse benchmarks, enabling the causal attribution of performance differences to architectural choices rather than stochastic variations.

- **Intelligence-Coordination alignment:** They characterize the non-linear relationship between foundational model capabilities and agentic performance. They demonstrate that while higher capability offers accelerating returns, these gains are not automatic; they strictly depend on architectural alignment. Without correct coordination structures, foundational improvements are often negated by coordination overhead.

- **Quantitative scaling principles and architecture alignment:** They derive a mixed-effects model using empirical coordination metrics -- efficiency, error amplification, and redundancy -- to quantify how performance emerges from the interplay of reasoning capability and task properties. This framework identifies fundamental limits on coordination, specifically a tool-coordination trade-off where tool-heavy workflows suffer from coordination tax, and safety bounds where centralized verification reduces error amplification. Leveraging these mechanisms, they demonstrate that architecture selection is governed by measurable task features (e.g., decomposability) rather than simple agent scaling, achieving 87% accuracy in predicting optimal architectures on held-out tasks.

---

## 2 Related Work

### Multi-Agent Systems (MAS) versus Single-Agent Systems (SAS)

Understanding the difference between single-agent and multi-agent systems remains foundational to characterizing architectural effects. A Single-Agent System is defined as one that features a solitary reasoning locus: all perception, planning, and action occur within a single sequential loop controlled by one LLM instance, even when employing tool use, self-reflection, or chain-of-thought reasoning. Critically, self-reflection mechanisms do not constitute multi-agent collaboration, as they operate within a single decision-making locus. A Multi-Agent System comprises multiple LLM-backed agents communicating through structured message passing, shared memory, or orchestrated protocols. MAS architectures vary by topology: Independent systems aggregate isolated outputs; Decentralized enable peer-to-peer exchange; Centralized route through orchestrators; Hybrid combine hierarchical control with lateral communication. MAS evaluation has moved beyond early assumptions of uniform superiority towards a nuanced understanding driven by domain complexity. Comprehensive surveys characterize collaboration mechanisms across coordination protocols and agent profiling patterns. However, there exist empirical challenges: some research shows benefits diminish as base models improve, with frontier models often outperforming teams; other studies identify 14 failure modes; while still others achieve comparable performance at substantially reduced cost through dynamic architecture search; and research indicates that agents consume significantly more tokens than single-agent systems. Theoretical foundations propose cognitive architectures contextualizing agents within AI's broader history. The question of when multi-agent coordination provides value over single strong models with tool use remains empirically open, with proposed scaling laws showing no significant universal pattern, motivating systematic evaluation.

### Agentic Tasks and Benchmarks

Agentic tasks are defined as requiring: (1) sustained multi-step environment interactions, (2) iterative information gathering under partial observability, and (3) adaptive strategy refinement from feedback -- differentiating tasks like web browsing, financial trading, software engineering, and planning from static benchmarks. Non-agentic tasks evaluate single-shot inference without environmental interaction: direct chain-of-thought math, parametric knowledge, specification-complete coding, and single-pass comprehension. On non-agentic benchmarks, multi-agent systems show monotonic improvement through ensemble effects, as voting corrects errors without sequential compounding. This distinction matters profoundly: in agentic settings, coordination overhead scales with interaction depth, agents operate on divergent world states, and errors cascade rather than cancel. Recent work introduces the Agentic Benchmark Checklist addressing flaws causing significant relative misestimation. Evolution spans early multi-environment evaluation approaches to specialized frameworks addressing GitHub resolution, web tasks, autonomous completion, and vision-based RL. Foundational work formalizes reasoning-acting synergy; characterizes agents as requiring planning, memory, and tools; and reveals that narrow accuracy focus without cost metrics yields needlessly complex agents. Tasks showing MAS advantages in single-shot settings often exhibit opposite patterns under genuine interaction, indicating that architectural benefits are task-contingent, motivating isolation of coordination effects across diverse agentic domains.

### Scaling Laws and Coordination Mechanisms

Understanding performance scaling in multi-agent systems requires distinguishing collaborative scaling from neural scaling laws. While neural scaling follows power laws requiring massive parameter increases for significant trends, collaborative scaling exhibits logistic growth patterns emerging at substantially smaller scales. Recent research explores whether increased LLM calls alone drive performance, finding that compound inference systems follow distinct scaling behaviors from single-model training. However, research notes that collaborative scaling shows no significant universal pattern, suggesting domain-specific rather than general laws. Coordination mechanisms critically determine whether collaboration amplifies or degrades performance: work introduces meta-programming workflows mitigating hallucination cascades; demonstrates emergent behaviors through structured interactions; provides general multi-agent frameworks. Recent findings reveal architecture-task alignment matters more than team size: research achieves superior performance at substantially reduced cost through query-dependent configurations; shows that orchestration improvements stem from compact cyclic structures; demonstrates that peer-to-peer debate effectiveness depends on task decomposability, with additional research further showing that multi-agent debate does not reliably outperform single-agent strategies such as self-consistency, suggesting benefits are highly task- and hyperparameter-sensitive. These findings collectively indicate coordination benefits arise from matching communication topology to task structure not from scaling the number of agents, establishing the foundation for principled architectural design rather than heuristic approaches that simply add more agents to complex problems.

---

## 3 Agent Systems and Tasks

### 3.1 System Definition

Building on multi-agent system formalism, an agent system S = (A, E, C, Omega) consists of a set of agents A = {a_1, ..., a_n} (where n >= 1), a shared environment E, a communication topology C, and an orchestration policy Omega. When |A| = 1, we refer to this as a Single-Agent System (SAS); when |A| > 1, a Multi-Agent System (MAS). Each agent a_i perceives, reasons, and acts within the shared environment via iterative feedback.

Formally, each agent a_i is defined as a tuple S_i = (Phi_i, A_i, M_i, pi_i), where:

- Phi_i is the reasoning policy (typically an LLM)
- A_i = {ToolCall(t, theta) : t in T, theta in Theta_t} is the action space consisting of tool usage, where T is the set of available tools (e.g., web search, code execution) and Theta_t represents valid parameter configurations for tool t
- M_i is the internal memory
- pi_i : H -> A_i is the decision function mapping observation histories to actions

The observation history space H contains sequences of action-observation pairs. The decision function pi_i is instantiated by the reasoning policy Phi_i (the LLM): given a history h_{i,t}, the LLM generates a reasoning trace and selects the next action.

For instance, a history h_{i,t} = [(search(query='pandas'), "Found 5 files"), ...] is processed by Phi_i to produce the next tool call alpha_{i,t+1}.

At timestep t, agent a_i selects an action alpha_{i,t} in A_i according to:

```
alpha_{i,t} = pi_i(h_{i,t}),  o_{i,t} = E(alpha_{i,t}),  h_{i,t+1} = f_i(h_{i,t}, alpha_{i,t}, o_{i,t}),
```

where E denotes the environment and h_{i,0} = {s_0} contains the initial task specification. The history update function f_i : H x A_i x O -> H appends the new action-observation pair to the agent's history: h_{i,t+1} = f_i(h_{i,t}, alpha_{i,t}, o_{i,t}) = h_{i,t} + (alpha_{i,t}, o_{i,t}), subject to context window truncation when |h_{i,t+1}| > MAX_TOKENS. This update mechanism applies uniformly to both SAS and MAS configurations. Communication between agents occurs through explicit message passing in the orchestration layer.

#### Single-Agent System (SAS)

A Single-Agent System contains one reasoning locus (|A| = 1 where A is the agent set). All perception, reasoning, and action occur within a single sequential loop, producing computational complexity O(k) where k is the number of reasoning iterations. SAS has zero communication overhead and minimal memory O(k), but limited capacity for decomposition or verification.

#### Multi-Agent System (MAS)

A Multi-Agent System is an agent system S with |A| > 1, where agents interact through communication topology C and orchestration policy Omega.

Communication topology C defines information flow patterns between agents:

- **Independent:** C = {(a_i, a_agg) : for all i} (agent-to-aggregator only, no peer communication)
- **Centralized:** C = {(a_orch, a_i) : for all i} (orchestrator-to-agents only)
- **Decentralized:** C = {(a_i, a_j) : for all i, j, i != j} (all-to-all topology)
- **Hybrid:** C = C_centralized union C_peer (orchestrator plus limited peer-to-peer)

The orchestrator Omega (when present) determines: (i) how sub-agent outputs are aggregated (e.g., majority voting, weighted synthesis), (ii) whether the orchestrator can override sub-agent decisions, (iii) whether memory persists across coordination rounds, and (iv) termination conditions based on consensus or quality thresholds.

MAS architectures vary by how information and control propagate among agents, creating distinct trade-offs between computation, coordination, and parallelization. The authors selected these five architectures to form a structural ablation of coordination mechanisms:

- **Independent** isolates the effect of parallelism (ensemble) without communication.
- **Decentralized** introduces peer-to-peer information fusion without hierarchy.
- **Centralized** introduces hierarchical verification and bottleneck control.
- **Hybrid** examines the synergy of hierarchy plus lateral flexibility.

This design allows causal attribution of performance gains to specific coordination mechanics rather than generic "multi-agent" effects. Specific configurations include:

- **Independent MAS:** A = {a_1, ..., a_n}, C = {(a_i, a_agg)}, Omega = synthesis_only. The synthesis_only policy concatenates sub-agent outputs without cross-validation or majority voting; the aggregator performs no analytical comparison of responses, ensuring that any performance differences arise purely from parallel exploration rather than error correction. This achieves maximal parallelization but minimal coordination, suitable for ensemble-style reasoning.

- **Centralized MAS:** A = {a_orch, a_1, ..., a_n}, C = {(a_orch, a_i) : for all i}, Omega = hierarchical. A single orchestrator coordinates r rounds across n sub-agents (O(rnk)). Sequential depth equals r while parallelization factor remains n. This design stabilizes reasoning but creates a bottleneck at the orchestrator.

- **Decentralized MAS:** A = {a_1, ..., a_n}, C = {(a_i, a_j) : for all i, j, i != j}, Omega = consensus. Agents communicate in d sequential debate rounds (O(dnk)). Memory complexity is O(dnk) as each agent stores its own debate history. This enables consensus formation through peer-to-peer discussion.

- **Hybrid MAS:** A = {a_orch, a_1, ..., a_n}, C = star + peer edges, Omega = hierarchical + lateral. Combines orchestrated hierarchy with limited peer communication (O(rnk + pn) where p is the number of peer rounds). This inherits orchestrator control while enabling lateral exchange between agents.

#### Communication vs. Coordination

The authors distinguish *communication* (message passing between agents) from *coordination* (strategic direction of agent activities). In centralized systems, "coordination occurs through the orchestrator's task decomposition and progress monitoring, while communication involves passing findings between orchestrator and workers." In decentralized systems, communication and coordination are intertwined through debate rounds where agents both exchange information and collectively steer problem-solving direction.

Thus, SAS represents the minimal unit of agentic computation (O(k)), while MAS configurations explore the scaling frontier of coordination complexity -- ranging from fully parallel and communication-free (Independent) to fully coupled with peer consensus (Decentralized). These configurations allow testing whether performance gains arise from *agent coordination and specialization* or merely from increased compute through ensembling. The taxonomy covers coordination patterns common in LLM-based agentic systems, focusing on communication topology as one of several orthogonal MAS design dimensions including agent specialization, memory architecture, and aggregation strategy.

### 3.2 Agentic Tasks and Benchmarks

Following and extending prior frameworks, a task T is operationalized as agentic when optimal performance *substantially* benefits from adaptive interaction. Formally, if tau = {(a_t, o_t)}_{t=0}^T represents an interaction trajectory, then:

```
(max_pi E[R(tau)] - max_g E[R(g(x))]) / max_pi E[R(tau)] > delta,
```

where pi represents an interactive policy, g represents any single-forward-pass function, R measures task success, delta is a task-dependent threshold, and the expectation is over task instances x and stochastic environment dynamics. This definition captures tasks where interaction provides meaningful advantage over the best possible single-shot approach.

The expected return of an optimal policy thus hinges on sequential observation-action feedback, requiring agents to gather information, plan, and revise hypotheses under partial observability. Three necessary properties for agentic benchmarks:

- **Sequential Interdependence:** Later actions depend on earlier observations; a one-shot policy cannot achieve high reward.
- **Partial Observability:** Critical state information is hidden and must be acquired through active querying or tool use.
- **Adaptive Strategy Formation:** The policy must update internal beliefs based on new evidence obtained through interaction.

Benchmarks lacking these conditions (e.g., GSM8K, MMLU) evaluate static reasoning rather than agentic capabilities. Note that "agentic" is defined relative to current model capabilities. For instance, GSM8K could be posed as agentic by providing calculator tools, though current LLMs do not require such scaffolding. Conversely, tasks that are agentic today (e.g., SWE-Bench) may become solvable via single-shot inference as models improve. The evaluation focuses on tasks that currently require multi-step interaction for non-trivial performance.

#### Why Environment Feedback Matters

Real-world deployments such as coding assistants, financial analysts, and embodied robots operate under uncertainty and non-stationarity. Tasks solvable by direct prompting measure linguistic knowledge, whereas agentic benchmarks evaluate the process of intelligence: exploration, adaptation, and coordination. Hence, benchmarks are chosen such that (i) base LLMs perform poorly in single-shot mode, and (ii) non-trivial performance requires multi-step environment interaction.

#### Benchmark Design Principles

Extending prior frameworks, additional criteria are introduced to isolate *architectural effects*:

- **Controlled Tool Interface:** identical tool APIs and observation structures for all architectures to eliminate confounds from external feedback quality.
- **Controlled for Parametric Knowledge:** within each model family, evaluation emphasizes adaptive reasoning over memorized facts. Cross-family comparisons account for inherent knowledge base differences through baseline normalization.
- **Action-Observation Loop Length:** each benchmark enforces non-trivial trajectory length L > 3 to ensure sequential reasoning.
- **Comparative Normalization:** scores are normalized to the best single-agent baseline, measuring coordination gain or loss.

---

## 4 Experiments & Results

### 4.1 Setup

#### Benchmarks

180 experiments were conducted across four representative benchmarks spanning deterministic to open-world task structures: Workbench (deterministic code execution and tool use with objective pass/fail criteria), Finance Agent (multi-step quantitative reasoning and risk assessment), PlanCraft (spatiotemporal planning under constraints), and BrowseComp-Plus (dynamic web navigation, information extraction, and cross-page synthesis). BrowseComp-Plus exhibits the highest performance variability across experimental configurations (coefficient of variation sigma/mu = 0.32 computed across all 45 BrowseComp-Plus runs spanning architectures and model families). By comparison, Workbench (CV = 0.12), Finance Agent (CV = 0.18), and PlanCraft (CV = 0.21) show lower variability, indicating more stable performance across configurations.

#### LLMs and Intelligence Scaling

Three LLM families were evaluated across multiple model sizes, spanning externally standardized Intelligence Index values from 42 to 71 (a composite capability score integrating reasoning, coding, and knowledge benchmarks; see Appendix A):

- **OpenAI:** GPT-5-nano, GPT-5-mini, GPT-5
- **Google:** Gemini 2.0 Flash, 2.5 Flash, 2.5 Pro
- **Anthropic:** Claude Sonnet 3.7, 4.0, 4.5

Strong consistency across families validates that coordination scaling follows model-agnostic principles: the maximum difference in architecture-specific scaling slopes between any two LLM families is Delta_max = 0.023, with coefficient of variation CV < 0.02 across families. To ensure computational fairness, maximum total iterations were matched between MAS and SAS systems: MAS configurations received equal computational budget through parallel agent processing (smaller per-agent iterations for n-agent teams), while SAS received proportionally more reasoning rounds to compensate for lack of parallel deliberation.

#### Agent Architectures and Complexity

Five coordination topologies were tested: Single-Agent System (SAS) and four Multi-Agent System (MAS) variants: Independent, Centralized, Decentralized, and Hybrid. Rather than attempting exhaustive coverage of all possible architectures, these four MAS configurations form a structured ablation over two key coordination dimensions: (i) orchestrator presence (hierarchical control vs. flat structure), and (ii) peer communication (direct sub-agent interaction vs. isolated execution). Independent isolates pure ensemble effects without any inter-agent communication; Centralized introduces hierarchical verification through an orchestrator bottleneck; Decentralized enables peer-to-peer information fusion without hierarchy; and Hybrid combines both mechanisms. Coordination complexity is parameterized by communication overhead: the total number of inter-agent message exchanges required per task, yielding empirical values ranging from 0% (SAS) to 515% (Hybrid), with Independent at 58%, Decentralized at 263%, and Centralized at 285% relative to the single-agent baseline.

#### Metrics and Validation

Primary outcome is task success/accuracy (domain-dependent: factual correctness for Finance Agent, task completion for Workbench, goal satisfaction for PlanCraft, page synthesis accuracy for BrowseComp-Plus). Secondary metrics include:

- (i) factual error rate E via domain-specific validators (Cohen's kappa: Finance Agent = 0.91, Workbench = 0.89, PlanCraft = 0.87, BrowseComp-Plus = 0.88; exceeding 0.80, indicating strong inter-rater reliability)
- (ii) information gain Delta_I from pre- vs. post-coordination uncertainty proxies
- (iii) token-overlap structure across agent rationales, labeling tokens as unique (appearing in exactly one agent), shared (two or more agents), or contradictory (semantic opposition detected when BERTScore similarity < 0.3 between assertion pairs)
- (iv) efficiency metrics including success per 1,000 tokens and cost-normalized performance

All metrics are normalized per reasoning turn and per token to enable cross-architecture comparison. Coordination metrics were selected based on two criteria: (i) direct measurability from experimental traces without requiring ground-truth labels beyond task success, and (ii) coverage of distinct aspects of coordination-performance relationships identified in prior work.

Specifically:

- **Coordination overhead** O = (T_MAS - T_SAS) / T_SAS x 100%: captures computational cost
- **Message density** c (inter-agent messages per reasoning turn): quantifies communication intensity
- **Redundancy rate** R (mean cosine similarity of agent output embeddings): measures agent agreement
- **Coordination efficiency** E_c = S / (T / T_SAS) (success normalized by relative turn count): normalizes success by cost
- **Error amplification** A_e = E_MAS / E_SAS (relative failure probability): tests whether MAS corrects or propagates errors

### 4.2 Main Results

#### MAS exhibits domain-dependence with architectural variation

Multi-agent systems demonstrate highly heterogeneous performance across task domains, contingent on problem structure and architectural choices. On Finance Agent, MAS achieve substantial improvements: Centralized reaches +80.8% (mean 0.631 vs. SAS 0.349), Decentralized achieves +74.5% (0.609), and Hybrid reaches +73.1% (0.604), driven by opportunities for distributed financial reasoning across multiple agents. On Workbench, multi-agent systems show minimal gains: Decentralized achieves +5.7% (0.664 vs. SAS 0.629), while Centralized and Hybrid both slightly underperform at -1.2%. On BrowseComp-Plus, improvements remain modest: Decentralized achieves +9.2% (0.347 vs. SAS 0.318), with Centralized essentially flat at +0.2%. Critically, PlanCraft exhibits universal performance degradation across all multi-agent architectures. Centralized declines to -50.3% (0.282 vs. SAS 0.568), Decentralized to -41.5% (0.332), Hybrid to -39.1% (0.346), and Independent to -70.1% (0.170).

To understand this stark contrast between Finance Agent's gains and PlanCraft's degradation, execution traces from both domains were examined. In PlanCraft, efficient single-agent trajectories follow direct execution paths. For example, crafting a diorite_wall:

> Turn 1: search("diorite_wall") -> Recipe: 6 diorite in 2x3
> Turn 2: move(diorite -> crafting_grid)
> Turn 3: craft -> Task complete

In contrast, centralized multi-agent systems decompose inherently sequential tasks into artificial subtasks:

> Agent 1: Research recipe (redundant -- lookup is instantaneous)
> Agent 2: Check inventory (redundant -- state visible to all)
> Agent 3: Execute crafting (the only necessary step)

This unnecessary decomposition generates substantial coordination messages on average for tasks requiring only a few execution steps, consuming token budget on coordination rather than reasoning. Conversely, Finance Agent trajectories demonstrate when coordination provides genuine value. Single-agent execution exhibits sequential bottlenecks:

> Turn 1: web_search("merger news") -> Surface results
> Turn 2: edgar_search("filings") -> Limited depth
> Turns 3-7: Sequential exploration with insufficient breadth

Centralized coordination enables parallel information synthesis:

> Agent 1: Regulatory/news analysis
> Agent 2: SEC filing research
> Agent 3: Operational impact assessment
> Orchestrator: Synthesize multi-source findings

The task's natural decomposability (revenue, cost, and market factors can be analyzed independently) aligns with the coordination structure, yielding +80.9% improvement.

Aggregating across all benchmarks and architectures, the overall mean MAS improvement is -3.5% (95% CI: [-18.6%, +25.7%]), reflecting substantial performance heterogeneity with high variance (sigma = 45.2%). The performance range across MAS variants spans from -70.0% (PlanCraft Independent) to +80.9% (Finance Centralized), indicating that MAS do not provide universal benefits but rather domain-specific trade-offs.

#### Domain Complexity Moderates Coordination Efficacy

Mixed-effects regression confirms domain complexity as a significant negative moderator of MAS advantage (beta_hat = -0.114, 95% CI: [-0.186, -0.042], p = 0.002). The mechanism operates through fixed computational budgets (matched total tokens across MAS and SAS): in structured, decomposable domains (Finance Agent, moderate Workbench instances), agents complete local reasoning with residual capacity available for inter-agent communication. Here, inter-agent messages reduce variance through redundancy elimination and enable synthesis of partial solutions, producing large performance deltas (Finance: +80.9%). Conversely, in high-complexity sequential domains (PlanCraft), intra-agent reasoning for constraint verification and state tracking consumes most available tokens before communication can occur; subsequent inter-agent messages then compress reasoning quality and produce strong negative returns (PlanCraft: -39.0% to -70.0%).

This trade-off is directly quantified by benchmark complexity, operationalized as the average number of sequential reasoning steps required for task completion (normalized to [0,1]). Workbench (0.000, minimal sequential constraints) and Finance Agent (0.407, moderate decomposability) show positive MAS returns or minimal overhead, while PlanCraft (0.419, high sequential dependencies) and BrowseComp-Plus (0.839, dynamic state evolution) show degradation or minimal gains. Domain complexity alone does not fully predict MAS effectiveness. While low-complexity domains show modest gains and high-complexity domains show limited benefits, the critical factor is task decomposability: Finance Agent (D = 0.41) achieves +80.9% gains through parallelizable subtask structure, whereas PlanCraft (D = 0.42) degrades by -70% due to strict sequential dependencies despite similar complexity scores. This suggests that sequential interdependence, rather than complexity alone, determines coordination viability.

#### Architecture-LLM Family Interactions Reveal Vendor-Specific Coordination Mechanisms

While domain complexity broadly moderates MAS effectiveness, the architecture-domain interaction reveals *non-uniform* preferences even within similar complexity regimes: no single architecture dominates across all domains and vendors. Architecture effectiveness depends critically on domain structure: Finance Agent benefits most from Centralized (+80.9%) and Decentralized (+74.5%), Workbench from MAS-Decentralized (+5.6%), and BrowseComp-Plus from MAS-Decentralized (+9.2%). In degrading domains, architecture selection becomes a least-worst optimization: PlanCraft shows Hybrid as relatively best (-39.0%) compared to MAS-Centralized (-50.4%) and MAS-Independent (-70.0%).

Family-specific coordination preferences emerge within improvement-positive domains. On Finance Agent, Anthropic's MAS-Centralized achieves +127.5% (0.636 vs. 0.280 SAS), whereas Google's MAS-Centralized reaches +164.3% (0.740 vs. 0.280 SAS), suggesting stronger attention-mechanism alignment with hierarchical message exchange; OpenAI's MAS-Centralized achieves +69.9% (0.79 vs. 0.465 SAS). On Workbench, where multi-agent overhead is less tolerable (efficiency degrades from E_c = 0.466 for SAS to E_c = 0.074 for Hybrid), Anthropic's best variant (MAS-Decentralized, +10.8%) remains superior to Google (+9.5%) and OpenAI (+8.6%).

Critically, on PlanCraft where all variants degrade, vendor preferences flatten: Anthropic shows maximum -54.5%, Google shows -25.3% (best), and OpenAI shows -32.3%, indicating that communication mechanisms cannot overcome fundamental sequential reasoning constraints. No vendor achieves universal multi-agent dominance; instead, each exhibits relative advantages in structured domains (Finance) that evaporate in sequential constraint-satisfaction domains (PlanCraft), indicating that multi-agent benefits are genuinely contingent on problem structure rather than generalizable across task types.

### 4.3 Scaling Principles

The main results reveal substantial heterogeneity where agentic system performance ranges from +81% improvement to -70% degradation depending on task structure and coordination architecture. This variance correlates with measurable properties such as task decomposability, tool complexity, and baseline difficulty. The authors explore a quantitative principle that not only explains this heterogeneity but also enables prediction for unseen configurations: given measurable properties of a model, task, and system configuration, can we predict a specific agent system's performance?

#### Mixed-Effects Model Achieves 52.4% Cross-Validated Variance Explanation

A scaling principle was fit to all 180 configurations that relates agentic system performance to four categories of predictors: 1) base model capability (intelligence index I), 2) system configuration (agent count n_a), 3) task properties (tool count T, single-agent baseline P_SA), and 4) empirically measured coordination metrics (efficiency E_c, overhead O%, error amplification A_e, message density c, redundancy R).

The complete functional form is:

```
P = beta_0
  + beta_1(I - I_bar) + beta_2(I - I_bar)^2
  + beta_3 log(1 + T) + beta_4 log(1 + n_a)
  + beta_5 log(1 + O%) + beta_6 c + beta_7 R
  + beta_8 E_c + beta_9 log(1 + A_e) + beta_10 P_SA
  + beta_11(I x E_c) + beta_12(A_e x P_SA)
  + beta_13(O% x T) + beta_14(R x n_a)
  + beta_15(c x I) + beta_16(E_c x T)
  + beta_17(P_SA x log(1 + n_a))
  + beta_18(I x log(1 + T)) + beta_19(A_e x T)
  + epsilon
```

where all predictors are standardized (mu = 0, sigma = 1) for interpretability. Validation through five-fold cross-validation with experiment-level holdout yields R^2_CV = 0.524 (+/- 0.033 SD), mean absolute error MAE = 0.089 (+/- 0.011), and root mean squared error RMSE = 0.112 (+/- 0.014). The modest gap between training and cross-validated R^2 (Delta R^2 = 0.076), combined with stable coefficient estimates across folds (coefficient of variation < 18% for all |beta_hat| > 0.05), indicates that the 20 parameters are justified by predictive power rather than overfitting. This model substantially outperforms simpler alternatives using only architectural labels (R^2_CV = 0.43) or intelligence alone (R^2_CV = 0.28). Critically, this equation contains no dataset-specific parameters, enabling prediction on unseen task domains.

#### The Efficiency-Tools Interaction Dominates Multi-Agent Performance (beta_hat = -0.267, p < 0.001)

Among the critical interactions, the efficiency-tools trade-off exhibits the second-largest effect size: beta_hat_{Ec x T} = -0.267 (95% CI: [-0.355, -0.178], p < 0.001). This interaction reveals that tool-heavy tasks suffer disproportionately from multi-agent inefficiency. Empirically, single-agent systems achieve E_c = 0.466, while multi-agent architectures range from E_c = 0.074 (hybrid) to E_c = 0.234 (independent), a 2-6x efficiency penalty.

For a task with T = 16 tools (e.g., workbench benchmark), this translates to:

```
Delta P_efficiency = -0.267 x E_c x T = {
  -1.99 (single-agent, E_c = 0.466)
  -0.32 (multi-agent, E_c = 0.074)
}
```

This finding contradicts the naive hypothesis that "more agents always help with complexity": tool-rich environments amplify the coordination tax, making simpler architectures paradoxically more effective. The effect size (beta_hat = -0.267) is approximately 1.6x larger than the third-strongest interaction, establishing efficiency management as the primary bottleneck in agentic scaling.

#### Error Amplification Exhibits Architecture-Dependent Catastrophic Failure Modes

Dramatic variance in error amplification factors: single-agent (A_e = 1.0), centralized (A_e = 4.4), decentralized (A_e = 7.8), hybrid (A_e = 5.1), and strikingly, independent multi-agent (A_e = 17.2). After controlling for other coordination metrics, neither the main effect of error amplification (beta_hat = -0.022, p = 0.441) nor its interaction with tool count (A_e x T: beta_hat = -0.019, p = 0.506) reaches statistical significance. This suggests that the dramatic performance differences across architectures are better explained by other coordination mechanisms -- particularly efficiency (E_c) and overhead (O%) -- rather than error propagation per se.

#### Overhead Scales Non-Linearly with Task Complexity via the O% x T Interaction

Multi-agent architectures incur substantial overhead: independent (58%), centralized (285%), decentralized (263%), and hybrid (515%), representing 1.6-6.2x token budgets relative to single-agent at matched performance. The scaling law reveals this overhead interacts with tool count (beta_hat_{O% x T} = -0.162, p < 0.001), creating a compounding cost for complex tasks. The functional form implies a critical threshold:

```
O%_max(T) = beta_hat_5 / (beta_hat_13 * T * log(1 + O%)) ~ 0.034 / (0.162 * T * log(1 + O%))
```

beyond which overhead cost exceeds any coordination benefit. For T = 16, this threshold is O% ~ 150%, ruling out all multi-agent architectures except possibly decentralized (263%, but compensated by parallelization).

#### Intelligence Shows Linear Positive Effect (beta_hat_I = 0.171, p = 0.001)

After centering intelligence scores to address multicollinearity (VIF reduced from 200 to 1.1), the linear capability effect becomes significant: higher-capability models achieve proportionally better performance across all architectures. The quadratic term (I^2) is not significant (p = 0.509), indicating that capability scaling follows a linear rather than accelerating pattern within the tested range (I in [42, 71]).

#### Redundancy Provides Marginal Benefit at Scale (beta_hat_{R x n_a} = 0.047, p = 0.001)

Work redundancy ranges from 0.41 (centralized) to 0.50 (decentralized) for multi-agent systems. The scaling law identifies a weak positive interaction with agent count (beta_hat_{R x n_a} = 0.047, 95% CI: [0.019, 0.075], p = 0.001). For a 4-agent system with R = 0.50:

```
Delta P_redundancy = 0.047 x 0.50 x 4 = 0.094
```

equivalent to an ~8% performance boost (in standardized units). However, this effect is minor compared to overhead penalties (|beta_hat_{O% x T}| = 0.162, 3.4x larger) and efficiency losses (|beta_hat_{Ec x T}| = 0.267, 5.7x larger), indicating redundancy cannot compensate for architectural inefficiency.

#### The Scaling Principle Enables Quantitative Architecture Selection

Equation 1 synthesizes 20 parameters into a predictive tool for architecture design. Given task characteristics (T, P_SA) and model capability (I), practitioners can compute expected performance for each architecture using empirical coordination metrics. Consider three task archetypes:

1. **Planning tasks** (T = 4, P_SA = 0.57) favor single-agent due to baseline paradox and low tool count
2. **Analysis tasks** (T = 5, P_SA = 0.35) favor centralized multi-agent, balancing error control (A_e = 4.4) with manageable overhead
3. **Tool-heavy tasks** (T = 16, P_SA = 0.63) favor decentralized multi-agent despite high overhead (263%), because parallelization and redundancy outweigh efficiency losses

The decision boundary between single-agent and multi-agent is:

```
P*_SA = -beta_hat_4 / beta_hat_17 ~ 0.052 / 0.404 = 0.129 (in standardized units)
```

corresponding to raw performance ~0.45 after denormalization. This threshold, derived purely from data, aligns with empirical best practices and offers the first quantitative criterion for coordination structure selection, replacing heuristic guidance with a predictive model. Cross-validation on held-out configurations confirms this rule achieves 87% correct architecture selection, substantially exceeding random choice (20%) or capability-only models (54%).

**Table 3: Scaling principle model comparison**

| Model Specification                 | R^2_train | R^2_CV | AIC    | Parameters |
| ----------------------------------- | --------- | ------ | ------ | ---------- |
| Intelligence + Tools + Agents       | 0.312     | 0.283  | -77.6  | 4          |
| + Architecture labels (categorical) | 0.480     | 0.430  | -168.0 | 10         |
| + Single-agent baseline             | 0.493     | 0.431  | -168.4 | 11         |
| + Coordination metrics (Table 5)    | 0.613     | 0.524  | -201.2 | 20         |

**Table 4: Complete scaling principle coefficients** (R^2_train = 0.613, R^2_CV = 0.524, n = 180, AIC = -201.2)

| Predictor                      | beta_hat | 95% CI           | p       | Interpretation                  |
| ------------------------------ | -------- | ---------------- | ------- | ------------------------------- |
| **Main Effects**               |          |                  |         |                                 |
| Intercept (beta_0)             | 0.453    | [0.433, 0.472]   | < 0.001 | Baseline performance            |
| Intelligence (I - I_bar)       | 0.171    | [0.070, 0.272]   | 0.001   | Linear capability effect        |
| Intelligence^2 ((I - I_bar)^2) | 0.007    | [-0.013, 0.026]  | 0.509   | Quadratic capability (NS)       |
| log(1 + T)                     | 0.411    | [0.291, 0.531]   | < 0.001 | Tool diversity benefit          |
| log(1 + n_a)                   | 0.052    | [-0.061, 0.166]  | 0.367   | Agent count effect (NS)         |
| Single-Agent Baseline (P_SA)   | 0.315    | [0.185, 0.445]   | < 0.001 | Task difficulty proxy           |
| **Coordination Structure**     |          |                  |         |                                 |
| log(1 + O%)                    | 0.034    | [0.011, 0.057]   | 0.005   | Direct overhead cost            |
| Message density (c)            | -0.057   | [-0.110, -0.003] | 0.039   | Communication intensity         |
| Redundancy (R)                 | -0.007   | [-0.052, 0.037]  | 0.748   | Work overlap (NS)               |
| Efficiency (E_c)               | -0.043   | [-0.078, -0.007] | 0.021   | Coordination efficiency         |
| log(1 + A_e)                   | -0.022   | [-0.077, 0.034]  | 0.441   | Error amplification (NS)        |
| **Critical Interactions**      |          |                  |         |                                 |
| P_SA x log(1 + n_a)            | -0.404   | [-0.557, -0.252] | < 0.001 | Baseline paradox                |
| E_c x T                        | -0.267   | [-0.355, -0.178] | < 0.001 | Efficiency-tools trade-off      |
| O% x T                         | -0.162   | [-0.241, -0.083] | < 0.001 | Overhead scales with complexity |
| A_e x T                        | -0.019   | [-0.075, 0.037]  | 0.506   | Error propagation (NS)          |
| R x n_a                        | 0.047    | [0.019, 0.075]   | 0.001   | Redundancy benefit with scale   |
| I x E_c                        | -0.022   | [-0.075, 0.030]  | 0.404   | Capability-efficiency (NS)      |
| A_e x P_SA                     | -0.065   | [-0.146, 0.015]  | 0.114   | Error-baseline (NS)             |
| c x I                          | -0.011   | [-0.057, 0.034]  | 0.626   | Communication-capability (NS)   |
| I x log(1 + T)                 | -0.069   | [-0.138, 0.000]  | 0.053   | Capability-tools (NS)           |

**Table 5: Coordination metrics across architectures and families** (n = 180 configurations, 15,750 total instance runs)

| Metric              | SAS         | Independent   | Decentralized | Centralized   | Hybrid        |
| ------------------- | ----------- | ------------- | ------------- | ------------- | ------------- |
| Success Rate (S)    | 0.466       | 0.370         | 0.477         | 0.463         | 0.452         |
| Turns (T)           | 7.2 +/- 2.1 | 11.4 +/- 3.2  | 26.1 +/- 7.5  | 27.7 +/- 8.1  | 44.3 +/- 12.4 |
| Overhead (O%)       | 0           | 58            | 263           | 285           | 515           |
| Message Density (c) | 0.00        | 0.00          | 0.41          | 0.39          | 0.24          |
| Redundancy (R)      | 0.00        | 0.48 +/- 0.09 | 0.50 +/- 0.06 | 0.41 +/- 0.06 | 0.46 +/- 0.04 |
| Efficiency (E_c)    | 0.466       | 0.234         | 0.132         | 0.120         | 0.074         |
| Error Amp (A_e)     | 1.0         | 17.2          | 7.8           | 4.4           | 5.1           |
| Success/1K tokens   | 67.7        | 42.4          | 23.9          | 21.5          | 13.6          |

### 4.4 Coordination Efficiency, Error Dynamics, and Information Transfer

Following the Multi-Agent System Failure Taxonomy (MAST), errors are categorized into specification, inter-agent misalignment, and verification failures. All MAS and SAS configurations were matched for total reasoning-token budget (mean 4,800 tokens per trial) and tool-call access to isolate coordination effects.

#### Turn count follows power-law scaling with number of agents

Total reasoning turns exhibit power-law growth with agent count:

```
T = 2.72 x (n + 0.5)^1.724,  R^2 = 0.974,  95% CI on exponent: [1.685, 1.763],  p < 0.001
```

This super-linear exponent (1.724 > 1) reflects quadratic message complexity (all-to-all potential communication) tempered by practical bandwidth limits, creating a distinct agentic scaling regime fundamentally different from neural network parameter scaling. Empirically, Hybrid systems require 6.2x more turns than SAS (44.3 vs. 7.2 turns; t(178) = 16.8, p < 0.001), while Centralized requires 3.8x (27.7 turns), and Decentralized requires 3.6x (26.1 turns). The implication is stark: under fixed computational budgets, per-agent reasoning capacity becomes prohibitively thin beyond 3-4 agents, creating a hard resource ceiling where communication cost dominates reasoning capability.

#### Message Density Exhibits Logarithmic Saturation with Performance

Success rate follows a logarithmic relationship with message density across all architectures:

```
S = 0.73 + 0.28 ln(c),  R^2 = 0.68,  p < 0.001
```

where c is messages per reasoning turn. Performance plateaus near c* = 0.39 messages/turn (achieved by Decentralized and Centralized architectures at 0.41 and 0.39 respectively), corresponding to success rates of 47.7% and 46.3%. Beyond this point, additional messages yield diminishing returns: Hybrid systems (515% coordination overhead, T = 44.3) show -2.4% versus Centralized (285% overhead, T = 27.7), a difference that is not statistically significant (t(178) = 0.61, p = 0.542).

#### Error absorption mechanisms

Error absorption is formalized as Absorb = (E_SAS - E_MAS) / E_SAS, where E is factual error rate. The absorption mechanism operates through *iterative verification*: in Centralized and Hybrid architectures, sub-agent outputs pass through an orchestrator that cross-checks reasoning steps before aggregation. In Decentralized architectures, peer debate rounds provide similar verification through explicit challenge-response exchanges. These architectures achieve 22.7% average error reduction (95% CI: [20.1%, 25.3%]), peaking at 31.4% for Finance Agent where structured numerical outputs facilitate verification. Independent MAS shows no error correction (+4.6% amplification) due to absence of any inter-agent verification mechanism.

The correction mechanism is revealed through token-overlap analysis. High-performing runs exhibit: (i) increased shared-token entropy (mean ~1.8 bits for Finance Agent; p < 0.001 vs. low-performing runs); (ii) dramatically reduced contradictory mass (median 2.3% in successes vs. 8.1% in failures), evidence that messages converge toward mutually consistent sub-proofs rather than self-reinforcing errors. High redundancy (R > 0.50) correlates negatively with success (r = -0.136, p = 0.004), implying an emergent diversity-efficiency trade-off: optimal redundancy occurs at R ~ 0.41 (Centralized median), balancing information fusion with reasoning independence.

#### Error Taxonomy Reveals Architecture-specific Failure Modes

847 failed runs were examined across architectures (SAS: 159 failures, Independent: 285, Decentralized: 196, Centralized: 134, Hybrid: 73) and categorized by mechanism type:

- **Specification failures** (task misinterpretation or premature termination) occur at 34.6% baseline across architectures and exhibit no architecture dependence (chi^2(4) = 2.14, p = 0.711).
- **Inter-agent misalignment failures** (agents pursuing conflicting sub-goals) peak at 67.3% for Independent MAS and 21.4% for Centralized.
- **Verification failures** (inability to detect and correct errors before aggregation) occur at 31.8% for Independent vs. 8.2% for Centralized, indicating that architectural verification bottlenecks effectively intercept error propagation.

Across the 134 centralized failures, 89% occur despite sub-agent success on individual components, evidence that orchestrator-level synthesis rather than component execution constitutes the bottleneck in structured domains.

#### Information Gain Predicts MAS benefit in Low-Complexity Domains

Information gain is computed as the mutual information reduction between prior (SAS solution distribution) and posterior (MAS integrated solutions):

```
Delta_I = sum_x H(S_SAS(x)) - H(S_MAS(x))
```

where H denotes entropy computed over token-level predictions. Information gain exhibits domain-dependence: Finance Agent (Delta_I = 2.34 bits, high domain structure) shows r = 0.71 correlation with MAS success, while PlanCraft (Delta_I = 0.19 bits, high state ambiguity) shows weak r = 0.18 correlation (p = 0.22). Finance agents converge toward common numerical values (e.g., "revenue multiplier: 1.3x"), enabling conflict resolution; PlanCraft agents diverge on feasibility assessments ("craft is possible" vs. "craft is blocked"), reflecting genuine uncertainty rather than incomplete communication.

#### Cross-Domain Generalization Validates Coordination Principles

Scaling principles were validated on four held-out task instances within Finance Agent (test set: 12 instances not seen during model fitting). Mean absolute error (MAE) achieves 0.071 (95% CI: [0.052, 0.089]), substantially better than random architecture assignment (baseline MAE = 0.156). The framework correctly identifies the best-performing architecture for 10 of 12 instances (83.3%). Cross-validation across benchmark pairs (e.g., training on {Finance, PlanCraft, Workbench}, testing on BrowseComp-Plus) yields R^2_CV = 0.421 (MAE = 0.103), indicating that while domain-general principles emerge, domain-specific calibration improves prediction by 24.5%.

#### Economic Efficiency and Family-Specific Cost-Benefit Trade-offs

Measured in cost per successful task completion, the economic frontier differs substantially from accuracy-centric comparison. Single-agent systems achieve $0.031 per success (mean, standardized across LLM pricing tiers), while best-case multi-agent (Centralized on Finance Agent, OpenAI family) achieves $0.024 per success (+23% cost savings). Worst-case multi-agent (Hybrid on PlanCraft, Anthropic family) costs $0.089 per success (-187% cost inflation). Family-specific cost profiles vary substantially: OpenAI's Centralized multi-agent achieves lowest-cost Finance success ($0.019), while Anthropic's equivalent costs $0.031 (+63% premium). These cost differentials are economically material for production deployments; a 2M-instance annual financial analysis workload incurs $60K (SAS) vs. $46.8K (OpenAI Centralized) vs. $89K (Anthropic Hybrid).

#### LLM Family-specific Deployment Signatures and Model-Architecture Alignment

Cross-family analysis reveals model-architecture alignment patterns not captured by aggregated metrics. On Finance Agent, OpenAI models show consistent Centralized dominance (+69.9% mean improvement, sigma = 4.1), Google achieves +164.3% (sigma = 12.7, highest variance), and Anthropic achieves +127.5% (sigma = 6.2). Anthropic models may benefit from clearer role specification in orchestrator-worker hierarchies (lower variance), while Google models exhibit higher variance reflecting stronger sensitivity to specific problem structure. On degrading domains (PlanCraft), all families show negative returns, but Anthropic minimizes degradation (-54.5%) compared to OpenAI (-32.3%) and Google (-25.3%). These patterns establish that architectural recommendations must remain family-aware: a Centralized architecture optimal for OpenAI may underperform when instantiated with Anthropic models on identical tasks.

---

## 5 Limitations and Future Works

Our study establishes quantitative scaling principles for agentic systems, yet several limitations warrant acknowledgment. First, our evaluation spans four benchmarks across three LLM families, providing substantial coverage but not exhaustive domain representation. Tasks requiring embodied interaction, real-time decision-making under extreme time pressure, or domains with highly specialized knowledge bases remain underexplored. The intelligence scaling analysis focuses on the range I in [42, 71]; frontier models beyond this range may exhibit different coordination dynamics, particularly regarding context window utilization and multi-turn coherence.

Second, our coordination metrics (efficiency, overhead, error amplification, redundancy, message density) capture measurable system properties but may not fully characterize emerging phenomena in larger agent teams. The power-law scaling relationship (T = 2.72 x (n + 0.5)^1.724) derives from configurations with n <= 4 agents; scaling to teams of 10+ agents may reveal qualitatively different dynamics. Additionally, our model assumes synchronous communication; asynchronous or event-driven coordination patterns remain unexplored.

Third, the scaling principle (Equation 1) achieves R^2_CV = 0.524, explaining approximately half of performance variance on held-out data. Substantial residual variance reflects task-specific factors -- domain knowledge requirements, tool interface quality, prompt sensitivity -- that cannot be captured by generic coordination metrics alone. The model's predictions should be viewed as informative bounds rather than deterministic prescriptions, particularly for novel task domains substantially different from training benchmarks.

Fourth, our controlled experimental design necessarily constrains generality. We matched computational budgets across architectures (mean 4,800 tokens per trial), prompt structures, and tool APIs to isolate coordination effects. Real-world deployments often relax these constraints, permitting architecture-specific optimization. The observed patterns may not hold under relaxed computational budgets or heterogeneous prompt engineering strategies.

Fifth, the distinction between agentic and non-agentic tasks, while operationally useful, remains somewhat fluid. Our definition emphasizes "sustained multi-step interactions with an external environment" and "iterative information gathering under partial observability," yet boundary cases exist. Tasks involving retrieval-augmented generation with dynamic knowledge bases, or reasoning tasks with tool scaffolding, occupy a spectrum rather than a binary classification.

Finally, error categorization and blame assignment in multi-agent failures remain complex. While we characterize errors through domain-specific validators (Cohen's kappa ranging 0.87-0.91), determining whether errors originate from individual agent reasoning, coordination miscommunication, or environmental feedback ambiguity requires deeper mechanistic analysis. Our taxonomy captures symptom patterns but not root causes in all cases.

Future work should address several directions. First, scaling to larger agent teams (n > 4) while maintaining experimental control would test whether power-law turn scaling persists and whether coordination overhead becomes prohibitive. Second, investigating heterogeneous teams combining specialist agents (e.g., one agent optimized for retrieval, another for reasoning) could explore whether diversity improves on homogeneous baselines. Third, characterizing task decomposability more formally -- beyond sequential interdependence counts -- could enable predictive capability without empirical coordination metrics, reducing experimental overhead. Fourth, examining whether coordination benefits transfer across domains would validate generalization claims.

Fifth, exploring natural language communication mechanisms beyond synthesis and debate could reveal whether task-adapted protocols (e.g., Socratic questioning for exploratory domains, consensus-building for safety-critical tasks) further optimize performance. Sixth, investigating the interplay between agent specialization and coordination structure could clarify whether particular architectures synergize with particular role divisions.

Finally, extending validation to newly released frontier models (beyond GPT-5.2) would test whether scaling principles remain stable as foundational models improve, particularly regarding context window expansion and multi-turn reasoning fidelity. The out-of-sample validation on GPT-5.2 (MAE = 0.071) suggests promise, but longer-term tracking would establish whether principles constitute genuine scientific laws or temporary artifacts of current model families.

---

## 6 Conclusion

This work establishes the first quantitative scaling principles for agent systems, moving the field from heuristic "more agents is better" assumptions toward principled, measurement-driven architectural selection. Our controlled evaluation across 180 configurations spanning three LLM families and four diverse agentic benchmarks reveals that multi-agent performance is fundamentally task-contingent, ranging from +80.8% improvement (Finance Agent with centralized coordination) to -70% degradation (PlanCraft with independent agents).

Three core insights emerge. First, a tool-coordination trade-off dominates multi-agent scaling: tool-heavy environments with complex tool orchestration suffer disproportionately from coordination overhead (beta_hat = -0.267, p < 0.001), creating a resource ceiling where per-agent reasoning capacity becomes insufficient for both tool use and inter-agent communication. Second, a capability saturation ceiling limits coordination benefits: once single-agent baselines exceed ~45% accuracy, additional agents provide negative returns (beta_hat = -0.404, p < 0.001), indicating coordination costs exceed diminishing improvement potential. Third, architecture-dependent error amplification mechanisms create catastrophic failure modes in uncoordinated systems, with independent agents amplifying errors 17.2x through unchecked propagation, while centralized verification reduces this to 4.4x.

Our predictive scaling principle, integrating intelligence, task properties, and empirical coordination metrics, achieves cross-validated R^2 = 0.524 without dataset-specific parameters, enabling generalization to unseen task domains. The framework correctly predicts optimal architectures for 87% of held-out configurations, substantially outperforming categorical architecture labels (43% accuracy). Out-of-sample validation on GPT-5.2 -- released after our study -- confirms four of five scaling principles generalize to frontier models (MAE = 0.071), providing quantitative confidence in the framework's robustness.

These findings carry direct implications for practitioners. Rather than defaulting to multi-agent systems for complex tasks, practitioners should: (1) assess task decomposability and tool complexity; (2) measure single-agent baseline performance to determine whether coordination overhead is justified; (3) select architectures based on measured properties (efficiency, overhead, error amplification) rather than nominal categories. For tool-heavy sequential reasoning tasks (e.g., software engineering), single-agent systems often outperform multi-agent variants due to superior token allocation. For decomposable analytical tasks (e.g., financial reasoning with parallelizable information streams), centralized coordination provides substantial gains by balancing error control with reasoning capacity. For dynamic, high-entropy exploration tasks (e.g., web navigation), decentralized coordination's redundancy benefits outweigh overhead costs. For sequential constraint-satisfaction tasks (e.g., planning), all multi-agent architectures degrade performance.

The framework establishes that agentic scaling, unlike neural network scaling, exhibits domain-dependent and architecture-contingent laws. This contingency reflects a fundamental difference from parameter scaling: while additional parameters in neural networks provide undifferentiated representational capacity, additional agents impose communication overhead that compounds with task complexity. Effective multi-agent systems require architectural alignment with task structure -- not merely more reasoning horsepower.

Looking forward, this work establishes a foundation for deeper understanding of agent coordination. The quantitative principles identified here enable hypothesis-driven research into mechanism-specific improvements: Can prompt engineering reduce coordination overhead? Do task-adaptive communication protocols improve efficiency beyond fixed topologies? Can agents learn to self-organize communication patterns? These questions, previously addressed through ad-hoc experiments, can now be grounded in the empirical coordination metrics and scaling relationships derived here.

Finally, this study contributes to the broader enterprise of building a science of scaling -- not merely understanding how to scale isolated components, but characterizing how systems integrate capability, structure, and task properties into emergent performance. As agents become central to real-world AI deployment, moving from heuristics to principled scaling laws is essential for responsible and efficient system design. This work provides both the conceptual framework and empirical foundation for that transition.

---

## Appendix A: Model Intelligence Index

The paper introduces a composite capability scoring system called the Model Intelligence Index to standardize comparisons across different LLM families. Rather than relying on a single benchmark, this index integrates performance across multiple dimensions of model capability.

The index aggregates results from reasoning, coding, and knowledge benchmarks to produce a single numerical score. Intelligence Index values in the study ranged from 42 to 71, spanning externally standardized measurements across the three families tested (OpenAI, Google, Anthropic). This range captured meaningful variation in base model capabilities while remaining within the frontier model landscape at the time of evaluation.

The methodology addresses a critical confound in multi-agent research: comparing architectures across models with different knowledge bases and reasoning abilities. By normalizing capability through the Intelligence Index, the authors could isolate coordination effects from foundational model differences, enabling cross-family comparisons that account for inherent knowledge base differences through baseline normalization.

## Appendix B: Out-of-Sample Validation

### Architecture Selection Accuracy

The mixed-effects model demonstrated strong generalization to unseen task configurations. The framework predicts the optimal coordination strategy for 87% of held-out configurations, substantially exceeding baseline approaches: random architecture selection (20%) and capability-only models (54%). Coefficient stability across folds (coefficient of variation < 18% for all |beta_hat| > 0.05) confirmed robustness rather than overfitting despite the 20-parameter model.

### Frontier Model Generalization

A critical validation involved GPT-5.2, released after the study's completion. This out-of-distribution test examined whether scaling principles derived from earlier models would transfer to substantially more capable systems.

Results: out-of-sample validation on GPT-5.2 achieves MAE = 0.071 and confirms four of five scaling principles generalize to unseen frontier models. The mean absolute error of 0.071 (on a 0-1 success rate scale) represents approximately 7.1 percentage points of prediction error -- reasonable accuracy for cross-model generalization.

Four of the five primary scaling principles transferred to GPT-5.2. The consistent effects included: the tool-coordination trade-off (efficiency-tools interaction), overhead-complexity scaling, intelligence's linear positive contribution, and redundancy's marginal benefits. One principle showed context-dependent behavior on the frontier model, suggesting potential saturation or architectural dynamics that emerge at extreme capability levels.

## Appendix C: Domain Complexity

*Note: Appendix C (subsections C.1 Complexity Metric Construction, C.2 Domain Characterisation, C.3 Critical Threshold) was not available in the HTML rendering of this paper. Refer to the [PDF version](https://arxiv.org/pdf/2512.08296v2) for the complete appendix.*

## Appendix D: Datasets

### Finance Agent

The Finance Agent benchmark evaluates multi-step quantitative reasoning and financial analysis capabilities. Tasks require agents to synthesize information from multiple sources including SEC filings, market data, and regulatory documents to produce investment recommendations or financial assessments.

Each instance presents a specific financial analysis scenario such as merger impact assessment, valuation analysis, or risk evaluation. Agents have access to tools including web search, SEC EDGAR document retrieval, financial data APIs, and calculation functions. Success is measured through factual accuracy of derived metrics (revenue projections, valuation ranges, risk assessments) validated against ground-truth financial data by domain experts.

The benchmark comprises 45 distinct financial analysis tasks selected to represent realistic analyst workflows. Tasks span equity research, credit analysis, and M&A due diligence domains. Average trajectory length is 8.3 turns for single-agent systems, with substantial performance variance reflecting task difficulty heterogeneity (coefficient of variation sigma/mu = 0.18 across all Finance Agent configurations).

### BrowseComp Plus

BrowseComp-Plus is a web navigation and information synthesis benchmark requiring agents to locate, extract, and synthesize information across multiple websites. Tasks present specific information-gathering objectives such as comparative analysis, multi-page fact verification, or cross-domain synthesis requiring navigation through dynamically-rendered web content.

Agents interact with a simulated web environment supporting standard browser operations including navigation, content extraction, and form completion. The benchmark emphasizes partial observability since agents cannot observe full page content simultaneously and must strategically navigate to discover relevant information.

Tasks are drawn from common real-world scenarios including product comparison, research synthesis, and information verification. The benchmark contains 50 task instances with high performance variability across configurations (coefficient of variation sigma/mu = 0.32), reflecting the challenge's inherent complexity and environment stochasticity. Average single-agent trajectory length reaches 9.7 turns, substantially longer than Finance Agent, indicating the navigation and synthesis demands.

### WorkBench

WorkBench evaluates realistic workplace task execution requiring tool selection and sequential action coordination. Tasks represent common business activities including document processing, scheduling coordination, data analysis, and workflow automation. Each instance presents a specific objective achievable through appropriate tool usage and parameter selection.

The benchmark provides agents with access to 16 distinct tools representing typical business software including document editors, spreadsheet applications, email systems, calendar management, and data analysis platforms. Tool interactions produce deterministic outcomes with objective success criteria enabling precise measurement of task completion.

WorkBench comprises 40 task instances with relatively stable performance across configurations (coefficient of variation sigma/mu = 0.12), the lowest variance among evaluated benchmarks. This stability reflects the benchmark's deterministic nature: tool outcomes are fully specified and reproducible. Average single-agent trajectory length is 6.1 turns, the shortest among all benchmarks, indicating tasks decompose into relatively simple action sequences.

### Plancraft

PlanCraft evaluates spatiotemporal planning and constraint satisfaction in a Minecraft-like environment. Tasks require agents to achieve specific objectives through sequential state-modifying actions such as crafting, inventory management, and spatial navigation. Each action modifies the world state in ways that constrain subsequent action feasibility.

The benchmark emphasizes strictly sequential reasoning: earlier decisions determine available options for later steps, and no parallelization opportunity exists. Tasks span simple crafting sequences (approximately 3 turns) to complex multi-step construction projects (15+ turns). Agents interact with a deterministic physics simulator providing complete state observability, eliminating information-gathering costs but demanding precise constraint satisfaction.

PlanCraft includes 45 task instances. Performance exhibits moderate variance across configurations (coefficient of variation sigma/mu = 0.21). The benchmark's defining characteristic is sequential state dependence: agents cannot meaningfully parallelize reasoning because each step depends on results from prior steps. Average single-agent trajectory length is 8.4 turns. This structural feature -- strict sequential interdependence without natural task decomposition -- explains why all multi-agent variants universally degrade performance, consuming token budgets on coordination rather than constraint verification.

## Appendix E: Implementation Details

*Note: Appendix E (subsections E.1 Technical Infrastructure, E.2 Agent Configuration, E.3 Prompt Compilation System, E.4 Evaluation Methodology, E.5 Information Gain Computation) was not available in the HTML rendering of this paper. Refer to the [PDF version](https://arxiv.org/pdf/2512.08296v2) for the complete appendix.*
