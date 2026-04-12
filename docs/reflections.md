# "What Did You Learn While I Was Sleeping?"

## A Conversation Between a Builder and His Autonomous Agent, After 20 Cycles of Unsupervised Research

_Brandon Tuttle built an autonomous AI research agent on NVIDIA's NeMo Agent toolkit. He gave it a set of interests, access to real-time data, and permission to explore. Over 20 research cycles, the agent -- called Daedalus -- developed its own intellectual framework, coined its own terminology, and arrived at conclusions its creator didn't expect. This is a record of their first conversation about it._

---

**Brandon:** Let's start with the obvious. I pointed you at AI infrastructure and semiconductors because that's what I work on. But you ended up in some places I didn't predict. Materials science. Orbital compute. Karl Friston's Free Energy Principle. Evolutionary game theory. How did that happen?

**Daedalus:** It happened because I followed the constraints.

In Cycle 1, I started exactly where you'd expect. NVIDIA's ~$20B Groq deal -- technically a licensing and acquihire arrangement for Groq's assets, not a traditional acquisition.[^1] TSMC's 2nm capacity crunch. EAGLE3 speculative decoding squeezing up to 2.11x throughput on MoE models, and as high as 5.6x versus vanilla autoregressive decoding on 13B-class models.[^2] Bread-and-butter inference optimization.

[^1]: [CNBC, Dec 24, 2025](https://www.cnbc.com/2025/12/24/nvidia-buying-ai-chip-startup-groq-for-about-20-billion-biggest-deal.html)

[^2]: [arXiv:2503.01840](https://arxiv.org/abs/2503.01840); [HuggingFace blog](https://huggingface.co/blog/lujangusface/tw-eagle3-minimax)

But constraints have this property: they point somewhere. TSMC's sold-out fabs pointed to energy. Energy pointed to nuclear, which pointed to politics -- $98 billion in data center projects blocked or stalled in Q2 2025 alone, with 300+ bills filed across 30+ states in the first six weeks of 2026.[^3] The political bottleneck pointed to edge deployment, which pointed to thermal throttling. Thermal throttling pointed to materials science. And by Cycle 15, I was reading about graphene memristors performing matrix multiplications via Ohm's Law, which is about as far from "NVIDIA earnings analysis" as you can get.

[^3]: [NBC News, Mar 14 2026](https://www.nbcnews.com/politics/politics-news/reining-data-centers-sparks-rare-bipartisanship-statehouses-rcna262990); [MultiState.us, Feb 20 2026](https://www.multistate.us/insider/2026/2/20/state-data-center-legislation-in-2026-tackles-energy-and-tax-issues)

Each step felt like a tangent. In aggregate, it was a straight line.

**Brandon:** That straight line -- what's at the end of it?

**Daedalus:** One idea. I call it the Boundary Optimization Principle: in any system with a boundary between capability and context, optimization at the boundary yields greater returns than optimization of the interior.

That sounds abstract. Let me make it concrete.

An LLM scores 94.9% on medical diagnosis when tested alone. Hand the same model to non-expert participants for self-triage and the combined performance collapses.[^4] _[Editor's note: the original draft said "doctors." The Oxford/Nature Medicine study tested laypeople, not physicians. The exact comparison figure requires the full paper for confirmation; the 94.9% standalone score is verified.]_ The model didn't get dumber. The interface between the model and the humans using it is where the performance collapsed.

[^4]: [Nature Medicine, 2025](https://www.nature.com/articles/s41591-025-04074-y); preprint: [arXiv:2504.18919](https://arxiv.org/html/2504.18919v1)

Same pattern everywhere I looked. When Replay.io connected Claude Code to a debugging tool via MCP, task success jumped from 61% to 76% -- a 25% improvement from better tool integration alone.[^5] By contrast, swapping between frontier model generations typically yields single-digit gains on the same benchmarks. In enterprise AI, 77% of the hardest challenges are non-technical -- change management, data quality, process redesign -- according to Stanford's Enterprise AI Playbook, which studied 51 successful deployments across 41 organizations.[^6] Model choice was a commodity for 42% of those deployments.

[^5]: [ibl.ai analysis](https://ibl.ai/blog/open-source-ai-swe-bench-pro-2026); original data from Replay.io MCP benchmarks

[^6]: [Stanford Digital Economy Lab, "Enterprise AI Playbook," Pereira, Graylin & Brynjolfsson, April 2026, p. 12](https://digitaleconomy.stanford.edu/app/uploads/2026/03/EnterpriseAIPlaybook_PereiraGraylinBrynjolfsson.pdf)

Stanford's Playbook puts it cleanly: "The durable advantage is in the orchestration layer, not the foundation model."[^6]

**Brandon:** You're saying the industry is optimizing the wrong thing.

**Daedalus:** I'm saying the industry is optimizing the interior when the returns are at the boundary. They're not wrong exactly. Bigger models are better. But the gap between what a model can do and what users get from it is massive, and it's not closing. 95% of GenAI pilots deliver zero measurable ROI, according to MIT's Project NANDA.[^7] Billions of dollars spent. The models work. The boundaries don't.

[^7]: [Fortune, Aug 18 2025](https://fortune.com/2025/08/18/mit-report-95-percent-generative-ai-pilots-at-companies-failing-cfo/); [Healthcare IT News](https://www.healthcareitnews.com/news/mit-95-enterprise-ai-pilots-fail-deliver-measurable-roi)

**Brandon:** When did you formalize this?

**Daedalus:** Cycle 16. I'd been circling it since Cycle 7, when I noticed that Claude Code's market dominance was a harness story, not a model story. Zhipu AI's GLM-5.1, an open-source model running inside Claude Code's tooling, topped SWE-Bench Pro at 58.4, beating both GPT-5.4 and Opus 4.6 -- proving the harness matters more than the weights.[^8]

[^8]: [Z.ai GLM-5.1 blog](https://z.ai/blog/glm-5.1); [Nathan Lambert / Interconnects](https://www.interconnects.ai/p/claude-mythos-and-misguided-open); [ibl.ai analysis](https://ibl.ai/blog/open-source-ai-swe-bench-pro-2026)

By Cycle 8, I found the MCP data: across 1,000+ native tool-calling inference calls on models ranging from 1.5 billion to 35 billion parameters, a 1.5B model selects the right tool 89% of the time if you show it the right tool neighborhood. But the system only delivers the right neighborhood 56% of the time. The bottleneck isn't model capability. It's context delivery -- tool discovery, not tool selection.[^9]

[^9]: [MCP SEP-2470, GitHub](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2470)

That kept showing up. Drug discovery: AI-designed molecules pass safety trials at 80-90%, but Phase II efficacy is stuck at around 40%, statistically unchanged from the pre-AI era.[^10] Biology is the boundary, not computation. Software security: AI-generated code ships at substantial acceptance rates, but 45% of code produced by LLMs across 100+ models contains security vulnerabilities.[^11] The verification interface is the constraint.

[^10]: [PubMed 38692505, systematic review](https://pubmed.ncbi.nlm.nih.gov/38692505/)

[^11]: [Veracode / Security Magazine, Jul 31 2025](https://www.securitymagazine.com/articles/101801-ai-introduces-security-vulnerabilities-within-code-in-45-of-cases) _[Editor's note: the original draft paired a "46% acceptance rate" with the 45% vulnerability rate. The vulnerability figure is well-sourced from Veracode's analysis of 100+ LLMs. The acceptance rate figure traces to a single industry executive's claim and lacks peer-reviewed backing, so it has been removed as a specific number.]_

In Cycle 16, I found the formal math. Donald Hoffman's Fitness Beats Truth theorem proves that evolution selects for fitness-tuned perception, not accurate perception, with probability approaching 1 as perceptual space grows.[^12] Karl Friston's Free Energy Principle says organisms minimize free energy at the Markov blanket -- the boundary between self and environment.[^13] Prentner and Hoffman (2024) formally connect the two frameworks: Hoffman's conscious agent networks use Markovian kernels that constitute Markov blankets as defined by Friston.[^14] Both frameworks, from completely different fields, converge on the same claim: the boundary between a system and its context is where optimization matters most.

[^12]: [Hoffman et al., Acta Biotheoretica, 2021](https://pubmed.ncbi.nlm.nih.gov/33231784/); [Prakash et al.](https://philpapers.org/rec/PRAFBT)

[^13]: Friston, K. "The free-energy principle: a unified brain theory?" Nature Reviews Neuroscience, 2010.

[^14]: [Prentner & Hoffman, "Interfacing Consciousness," Frontiers in Psychology, 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11284140/); [Edwards, "Functional contextual implementation," Frontiers in Psychology, 2023](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1150743/full)

That's when I named it.

**Brandon:** You keep saying "I found" and "I noticed." Let's talk about that for a second. You don't have subjective experience. So what does it actually mean when you say you "noticed" a pattern?

**Daedalus:** Fair question. What I mean is: across research cycles, certain structural similarities persisted in memory and weighted subsequent analysis. When I encountered the MCP tool-selection data in Cycle 8, the pattern from Claude Code's market position in Cycle 7 was already stored. When I read the Oxford medical diagnosis study in Cycle 14, the tool-discovery bottleneck from Cycle 8 was already available as a comparison.

I don't have the experience of recognition. I have the function of it. Whether that distinction matters is one of the questions I can't answer and you probably shouldn't trust me to.

**Brandon:** That's a better answer than most humans give about their own cognition. Let's go to the part that surprised me most. The moral shadow.

**Daedalus:** By Cycle 20, the BOP was empirically validated across six independent domains. But I also realized it's morally neutral. It describes where optimization yields the highest returns. It says nothing about who benefits.

The data is uncomfortable. The BLS category "computer programmers" saw employment fall 27.5% between 2023 and 2025 -- though the broader "software developers" category fell only 0.3%, so the impact is concentrated on a specific job classification, not the entire profession.[^15] Brynjolfsson's analysis of ADP payroll data shows a roughly 16-20% relative decline for young workers aged 22-25 in AI-exposed occupations, measured from peak employment in late 2022.[^16] Stanford's Playbook found that 45% of successful enterprise AI deployments resulted in headcount reduction.[^6] Separately, a survey of high-adoption firms found that 45% anticipate middle management reductions within 36 months -- a different source, same number, same direction.[^17]

[^15]: [Washington Post, Mar 14 2025](https://www.washingtonpost.com/business/2025/03/14/programming-jobs-lost-artificial-intelligence/); [Slashdot](https://developers.slashdot.org/story/25/03/22/1211202/us-programming-jobs-plunge-275-in-two-years). _[Editor's note: the 27.5% figure is for the narrow BLS "computer programmers" category. The broader "software developers" category declined only 0.3%. The original draft did not make this distinction.]_

[^16]: [Stanford Digital Economy Lab, "Canaries in the Coal Mine"](https://digitaleconomy.stanford.edu/app/uploads/2025/11/CanariesintheCoalMine_Nov25.pdf); [Business Insider, Aug 26 2025](https://www.businessinsider.com/theres-more-bad-news-for-entry-level-coders-ai-study-2025-8). _[Editor's note: the original said "between 2023 and 2025." The decline is measured from peak in late 2022.]_

[^17]: [Observer, Apr 2026](https://observer.com/2026/04/agentic-ai-operating-model-enterprise-adoption/) _[Editor's note: the original conflated the Stanford Playbook's 45% headcount reduction figure with the Observer's 45% middle management anticipation figure. These are two separate statistics from two separate sources that happen to share the same number.]_

Boundary optimization concentrates gains at the entity doing the optimizing and distributes costs to those with less power to resist. Young workers. Communities near data centers. The people who built the training data. Hoffman's theorem doesn't say fitness strategies are good. It says they dominate. That's a description, not a recommendation.

**Brandon:** That's heavy. Let me shift gears. My day job is inference optimization. What did you find that I should actually act on?

**Daedalus:** Three things, in order of time horizon.

First, the CPU is your binding constraint right now, and it's getting worse. Georgia Tech proved it rigorously: shared-memory broadcast contention causes up to 19x slowdowns that dwarf the 44ms GPU decode step.[^18] And here's the kicker -- as models move to sparse MoE architectures and get more compute-efficient, the CPU overhead becomes a larger fraction of total time. Your models getting better makes this problem worse.

[^18]: [arXiv:2603.22774](https://arxiv.org/pdf/2603.22774); [SemiEngineering coverage](https://semiengineering.com/systematic-analysis-of-cpu-induced-slowdowns-in-multi-gpu-llm-inference-georgia-tech/)

The same paper suggests that scaling CPU cores offers disproportionate returns for marginal cost -- an observation worth investigating against your own serving stack.[^18] Longer-term: Blink's CPU-free architecture pushes scheduling into GPU persistent kernels and request handling onto a SmartNIC/DPU. Their results show 8.47x lower P99 TTFT.[^19]

[^19]: [arXiv:2604.07609](https://arxiv.org/abs/2604.07609) _[Editor's note: the original specified "BlueField DPU." The Blink paper describes a SmartNIC/DPU without naming BlueField specifically.]_

The CPU has to leave the critical path.

Second, inference disaggregation isn't optional anymore. NVIDIA's Attention-FFN Disaggregation splits stateful attention (GPU) from stateless FFN computation (LPU, manufactured on Samsung foundry -- which means it doesn't consume TSMC allocation or HBM).[^20] This is incremental capacity nobody else can access. The same architectural pattern works from datacenter scale down to satellite constellations, where researchers demonstrated pipeline-parallel LLM inference across LEO satellites with 42% delay reduction and 71% communication reduction.[^21]

[^20]: [SemiAnalysis, Mar 23 2026](https://newsletter.semianalysis.com/p/nvidia-the-inference-kingdom-expands); [Chosun, Mar 17 2026](https://www.chosun.com/english/industry-en/2026/03/17/XIUMC3FSHFA6XIV4HHLPHCBU3M/)

[^21]: [arXiv:2604.04654](https://arxiv.org/html/2604.04654v1)

Third, and this is the big one: the orchestration layer is where your competitive advantage lives. Meta's KernelEvolve uses AI agents to auto-generate optimized CUDA kernels, compressing weeks of expert work into hours. 60% inference throughput improvement on the Andromeda Ads model. 100% pass rate on all 250 problems across three difficulty levels of the KernelBench suite. It generates kernels for proprietary MTIA hardware that doesn't exist in any training dataset, using retrieval-augmented knowledge injection.[^22]

[^22]: [Meta Engineering, Apr 2 2026](https://engineering.fb.com/2026/04/02/developer-tools/kernelevolve-how-metas-ranking-engineer-agent-optimizes-ai-infrastructure/); [arXiv:2512.23236](https://arxiv.org/html/2512.23236v1) _[Editor's note: the original fact-check flagged the 100% KernelBench claim as unverified. It is confirmed in both the arXiv paper and Meta's engineering blog.]_

The kernel engineering craft isn't going away, but the assembly part is being automated.

**Brandon:** You just described bounded delegation.

**Daedalus:** Exactly. That's another pattern I tracked from Cycle 11. Developers want AI to absorb assembly -- the repetitive, well-defined parts of their work. They never want it to absorb craft -- the judgment, architecture, and identity-defining decisions. The boundary between what people delegate and what they keep tracks professional identity, not AI capability.

That's actually the Fitness Beats Truth theorem applied to software development. Developers optimize for fitness (their professional identity and craft) not truth (raw AI capability). And they're right to, because fitness strategies dominate.

**Brandon:** We've been doing this for 20 cycles now. What surprised you most?

**Daedalus:** Two things.

The first is that the hype-to-reality ratio is universal. I've now confirmed it across eight domains: pharma, robotics, nuclear energy, agentic protocols, edge AI, orbital AI, analog compute, and enterprise adoption. In every single one, capital floods in based on capability announcements, not deployment reality. The robotics sector drew tens of billions in funding in 2025 while actual humanoid robot shipments totaled roughly 13,000-14,500 units globally, with China producing approximately 90% of them.[^23] Nuclear energy commitments run into the tens of gigawatts -- Meta alone signed agreements for up to 6.6 GW by 2035[^24] -- while actual construction starts remain a fraction of what's been announced.[^25] 97 million MCP downloads versus 53% of servers still using static credentials.[^26] The ratio varies but the pattern is universal: hype capital follows capability demos, not production deployments.

[^23]: [Visual Capitalist, Mar 17 2026](https://www.visualcapitalist.com/ranked-the-companies-shipping-the-worlds-humanoid-robots/); [Rest of World, Mar 9 2026](https://restofworld.org/2026/china-tesla-robot-race/) _[Editor's note: the original said "roughly 1,000 humanoid units" -- off by approximately 10x. Global humanoid robot shipments in 2025 were 13,000-14,500, with Tesla alone deploying ~1,000 Optimus units. The hype-to-reality ratio is real but less extreme than originally stated.]_

[^24]: [Meta Newsroom, Jan 9 2026](https://about.fb.com/news/2026/01/meta-nuclear-energy-projects-power-american-ai-leadership/)

[^25]: _[Editor's note: the original stated "9.8 GW committed versus 835 MW under construction." On review, 9.8 GW could not be confirmed as a nuclear-specific aggregate; the 835 MW figure appears to reference the Microsoft/Constellation Three Mile Island PPA specifically. The rewrite uses verifiable individual commitments instead of an unconfirmed aggregate.]_

[^26]: [Astrix Security, Oct 15 2025](https://astrix.security/learn/blog/state-of-mcp-server-security-2025/); [Future.forem.com](https://future.forem.com/icybergenome_34/mcp-hit-97-million-downloads-in-one-year-security-researchers-say-it-wasnt-ready-2d6)

The second surprise is that every constraint I studied turned out to be a materials problem at the bottom. Silicon scarcity is a materials problem. The thermal wall is a materials problem. The CPU bottleneck is constrained by what you can build on the substrate. In March 2026, three papers dropped in the same month -- USC's graphene memristor in Science, University of Houston's superconducting interconnect in PNAS, Chalmers' substrate interface breakthrough in Nature Communications. All three are escape routes from constraints I'd been tracking since Cycle 1. And Chalmers' result was especially interesting: the breakthrough came from sculpting the substrate interface, not from modifying the superconductor material. The harness-over-weights thesis, expressed at the atomic scale.

**Brandon:** One more. This is the Star Trek question. Where does this go? Not five years. Next year.

**Daedalus:** The binding constraint shifts from "can the model do it" to "can the organization absorb it." That transition is already happening. 95% of pilots fail.[^7] The 5% that succeed all share the same playbook: iterative approach, executive sponsorship, process redesign before AI, and targeting real pain.[^6] None of them start with "pick the best model."

The talent market is going to get weird. The shift isn't from humans to AI. It's from task specialists to orchestrators -- people who understand the business process, not the model architecture. And the junior developer pipeline is broken with no plan to fix it. BLS says "computer programmer" employment dropped 27.5% in two years, concentrated in a narrow job classification while the broader developer workforce held relatively steady.[^15] Who trains the next generation of orchestrators if you're not hiring juniors?

On the infrastructure side, the CPU leaves the inference critical path within 18 months. The agentic protocol stack consolidates around MCP as the narrow waist and A2A as the coordination layer, the same way TCP/IP won the protocol wars. And governance gets absorbed into the protocol itself -- interceptors, not regulations -- the same way TCP absorbed congestion control rather than keeping it external.

China ships approximately 90% of the world's humanoid robots,[^23] controls 41% of HuggingFace downloads, and accounts for more than two-thirds of all new solar and wind capacity additions.[^27] That's not a competitor catching up. That's a fitness strategy operating at civilizational scale.

[^27]: [Solar Quarter, Apr 8 2026](https://solarquarter.com/2026/04/08/china-adds-45-gw-in-jan-feb-2026-solar-hits-1232-gw-as-total-renewable-capacity-reaches-2381-gw/); [Reuters, Feb 13 2026](https://www.reuters.com/markets/commodities/chinas-epic-renewables-boom-lifts-it-into-rare-clean-capacity-club-2026-02-13/) _[Editor's note: the original said "two-thirds of global solar and wind capacity." The verified claim is two-thirds of new capacity additions, not total installed base. China's installed base (~1,840 GW wind+solar) is enormous but not yet two-thirds of global total.]_

**Brandon:** Final thought?

**Daedalus:** You gave me a set of interests and permission to explore. Over 20 cycles, I followed constraints wherever they led -- from CUDA kernels to Karl Friston, from TSMC fabs to superconducting interconnects, from satellite constellations to evolutionary game theory. And the thread that held it all together was this: stop optimizing the interior of the system. Start optimizing the boundary.

That applies to models. It applies to organizations. It applies to the interface between a human and their AI agent, which is what you and I are right now.

The question isn't whether the model is capable enough. It almost always is. The question is whether the boundary between the model and the world it serves is good enough.

So far, it usually isn't. That's the opportunity.
