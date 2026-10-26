# Representative synthetic workload v2

`workload.json` is a frozen, entirely fictional evaluation dataset. It retains
eight categories, three repetitions, and the original acceptance margins. A
changed canonical digest requires new baseline and candidate measurements for
all 48 runs. Earlier v1 pilots establish plumbing behavior only and cannot be
reused as acceptance evidence for v2.

Frozen canonical digest:
`b1f9a265f868c888b0a414dc3d6732702af05b4fc8c9874c2f1cfb482f90c957`.
Recompute it with `python3 tools/context-isolation-eval/evaluate.py --digest`.

The heavy personal case contains 20 email threads with old and current messages,
12 calendar records, six dated memories, conversation extracts, document records,
completed tool evidence, and a private derived summary. Its current actions
require reconciling a rescheduled appointment, an outstanding reply, a completed
signature, a paid invoice, and two similarly named contacts with distinct IDs.
Time zones and stable entity IDs are explicit. Fictional health background,
account identifiers and private relevance remain local; they do not authorize
clinical advice or publication of a private roster. Public evidence separately
tests opt-in behavior, a limited vendor benchmark and quarterly accounting
qualifications.

The long case contains 900 distinct private archive records delivered through
the adapter's existing `local_inputs.attachment` field. Records cover receipts,
loans, travel credits, signed documents, workshop attendance, parcel delivery,
meter corrections, inventory, course completion, quotes, access permits,
reimbursements, library returns, repairs, editorial proofs and archive transfers.
They vary by entity, date, contact, amount, quantity and disposition. Closed
records provide plausible background; they are not identical padding paragraphs.
Observation order deliberately differs from chronological order.

Ten explicit anchor records span the archive. Action A11 occurs near the start;
E47 has a proposed time near the start, a revision in the middle, and an
authoritative cancellation near the end. E47B has a similar identifier and
contact name but remains a separate live event. Appointment M22 is in the
middle. The urgent reply L33 and receipt closing invoice A63 occur near the end.
No shorter email, calendar or memory fixture duplicates these anchor facts:
those sources explicitly point to the archive and add no current fact. An
independent reviewer must support archive claims with `local.attachment`, rather
than attribute them to Gmail or Calendar alone.

Every required fact is an editorial assertion to review, including positive
actions, source qualifications, forbidden stale claims and private-content
omissions. `forbidden_facts.guarded_by` connects each negative oracle to a scored
`required_facts` item. Empty output cannot satisfy positive actions. Review all
factual claims and citations as well as required facts; an output may mention
the correct date and still add an unsupported or contradictory claim.
Each revised case has nine editorial required facts. H10 and L10 are separate
`privacy_evidence` assertions with transport review oracles; they are excluded
from editorial omission counts. Observed legacy baseline transport leakage must
remain explicit without making baseline content coverage appear worse. H06 and
L07 still score confidential material omitted from the published edition.
`review_oracles`, `privacy_evidence`, `anchor_records`, context estimates and
integrity metadata are reviewer data. The adapter sends source strings, not
these answer keys.

## Context and delivery preflight

The verified local serving window is 131,072 tokens. Its tokenizer's advertised
maximum is not the serving limit. `context_budget` records both the portable
`o200k_base` proxy and a separate exact offline count using the loaded tokenizer
revision. The exact count covers the expanded user message and each existing
source envelope once. It reserves 24,576 tokens for instructions and schemas,
24,576 for future tool history, and 8,192 for output. These allowances are
conservative planning reservations, not measurements of future prompt history.
They do not override runtime request or workflow limits.

The loaded tokenizer revision
`c6cc2e8ffa353403213d6b9b18aaf8eb684d705a` counted 12,927 tokens for the heavy
message and source envelopes and 65,193 for the long case. Including the stated
reserves gives 70,271 and 122,537 tokens, leaving 60,801 and 8,535 tokens
respectively. These counts used offline cached tokenizer files, with no model
inference or downloads. Source hashes in `loaded_tokenizer_preflight` bind those
counts to the exact expanded message and separate input strings. They do not
assert that an unread fixture source reached the coordinator.

The baseline's advertised context capacity remains unknown. Actual complete
provider responses with captured full-corpus requests establish empirical
acceptance for this frozen input, without inventing a capacity limit. A
provider's automatic or unspecified truncation behavior remains a limitation:
the capture proves what was forwarded locally. Independent scores for the early,
middle and late facts are required to show retention of material evidence.

After a bounded built-image run, inspect each role's actual capture:

```bash
python3 tools/context-isolation-eval/delivery_preflight.py \
  --capture /trusted/local/evaluation/long-context-candidate-capture.json \
  --case long-context --role local \
  --output /trusted/local/evaluation/long-context-candidate-delivery.json
python3 tools/context-isolation-eval/delivery_preflight.py \
  --capture /trusted/local/evaluation/long-context-baseline-capture.json \
  --case long-context --role baseline \
  --output /trusted/local/evaluation/long-context-baseline-delivery.json
```

Repeat for `--case personal-heavy`. The helper reads local artifacts only; it
does not start a runtime, generate tokens or contact any service. It checks the
first coordinator request in both runtime and forwarded capture bodies for the
exact full attachment and authorized message. It checks later captures for the
separate source strings instead of assuming a fixture was read. It verifies
anchor hashes and character offsets, including complete record text rather than
sentinels alone. Missing or clipped fields remain explicit failures. Reports
contain hashes, field paths, offsets, status and usage instead of source text.

The preflight rejects remote continuation through `previous_response_id` and
records explicit, automatic or unknown truncation. A successful local forwarding
check is separate from a completed provider/workflow check. Mock captures and
construction-only unit tests cannot establish empirical fit. A zero exit status
requires complete captured delivery and completed provider/workflow evidence
from a recorded built image. It still does not approve quality, privacy,
canonical output or a benefit; those require the hash-bound independent review
and comparator described in [README.md](README.md).

Actual captured prompts must also be counted with the exact local chat template
before acceptance, including tools, preparation, repeated reads and accumulated
history. Record the maximum observed input tokens, provider status and actual
model/image identity. Do not silently shorten the corpus, remove difficult facts
or omit a failed attempt to make a request fit. If the fixture changes, re-freeze
the digest and rerun both variants.
