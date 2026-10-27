# Brandon's identity and old “User” references

Brandon clarified on 2026-10-27 that he is the only user in this Hindsight database. Existing personal facts that call the owner “User” should identify him as Brandon. A Mental Model can present those references correctly, but refreshing it does not rewrite its underlying facts. This file separates future extraction, old fact corrections, and refreshed summaries.

## 1. Save the identity as evidence

Paste this into Hindsight's retain/add-memory interface for Brandon's existing bank. It is a memory, not a Mental Model source query:

```text
Identity clarification dated 2026-10-27: Brandon is the only user in this personal memory database, and his name is Brandon.

The owner of these personal memories is Brandon. In personal memories about the database owner, “User,” “the user,” and the conversational user role refer to Brandon. These labels do not identify another person. This clarification does not identify generic users or people quoted in imported material as Brandon.
```

Suggested context: `Brandon's explicit clarification of his name and ownership of his personal memory database, 2026-10-27`.

The identity source query already includes the confirmed name so the draft can render it correctly. Saving this note separately makes the evidence available outside that one query. Identity evidence alone does not guarantee that each future extraction receives it.

## 2. Make future extraction name the owner

The current Daedalus retention code serializes messages with `role: "user"` and `role: "assistant"`. Its context says `Daedalus completed interactive turn`; it does not supply Brandon's display name. This is a plausible contributor to the recurring generic subject, based on [`memory_api.rs`](../../builder/runtime/src/memory_api.rs), rather than a live diagnosis of the database.

In Hindsight's bank configuration, preserve a copy of the existing effective `retain_mission` and `observations_mission`. Append the following owner-specific guidance to the respective missions, preserving the existing extraction, evidence, and privacy guidance. Apply it to Brandon's bank, rather than a server-wide template that could later serve someone else. These settings are applied separately from model creation; the loader does not change bank missions.

**Append to `retain_mission`:**

```text
Identity context for this bank: the human owner is Brandon. When extracting a personal fact about the owner from a Daedalus interactive conversation, name its subject Brandon rather than “User” or “the user.” The conversational user role identifies Brandon; the assistant role identifies Daedalus. Preserve that distinction when recording who said, preferred, decided, or performed something. Keep other people, generic users, and speakers quoted in external material separate. Do not alter original quotations or protocol role labels. If a subject is genuinely ambiguous, retain the ambiguity rather than assigning it to Brandon.
```

**Append to `observations_mission`:**

```text
The owner of this bank is Brandon. Reconcile owner-specific references recorded as “User,” “the user,” or Brandon when their provenance identifies the same person. Describe that person as Brandon in synthesized observations. Preserve attribution to Daedalus and to other people, and preserve generic uses of “user” in source material. Resolve newer explicit identity corrections against older generic wording without inventing new personal facts.
```

A systemic subject-extraction problem belongs in the extraction/consolidation missions; Hindsight documents source reprocessing as the broader repair path. Changing missions affects later processing, not every existing fact immediately. [Hindsight curation guidance](https://hindsight.vectorize.io/developer/api/memories)

Daedalus's bootstrap fills missing bank overrides; it does not replace existing ones. A deliberate bank override is compatible with that behavior. Keep a local copy of the final missions and previous values so the setting can be restored or re-applied after rebuilding the bank. Do not replace the entire configuration with only these two fields.

## 3. Correct existing personal facts

For a manageable set of records, use Hindsight's fact-editing API or Daedalus's Memory Center. Review the wording of each candidate with `User`/`user` as its subject. The distinction is semantic, even in a one-person database: `The user prefers Markdown` describes Brandon; `The API authenticates a user` may describe software behavior.

1. Save the affected records before editing: IDs, original text, context, entities, dates, and state. Save the bank configuration separately. Preserve a database backup if undertaking a large reprocessing job.
2. Edit supported **world** and **experience** facts so personal owner references say Brandon. Preserve the fact's meaning, dates, other subjects, and provenance. Leave raw transcript role keys and direct quotations intact.
3. If a fact has an incorrectly linked `User` entity, inspect all its entity associations. When supplying an updated `entities` list, preserve every unrelated entity and set `resolve_entities: false` so the intended name is taken literally. Supplying `entities` replaces the complete set; it is not an append operation.
4. Allow background graph and observation updates to finish. Observations are derived and cannot be corrected with the same fact PATCH endpoint; fix their supporting facts.
5. Refresh the affected Mental Models and Knowledge Pages after the corrections settle. Check the results and source attribution rather than relying on a stale indicator alone.

Hindsight documents that editing a raw fact triggers re-embedding and background rebuilding of derived knowledge. It also documents the exact-name option for entity corrections. Installed-version behavior should be verified on one record before a bulk job. [Hindsight fact editing and entity resolution](https://hindsight.vectorize.io/developer/api/memories#edit-a-memory)

Example request shape, using an actual reviewed memory ID and actual corrected text:

```http
PATCH /v1/default/banks/EXISTING_BANK_ID/memories/REVIEWED_MEMORY_ID
Content-Type: application/json
Authorization: Bearer YOUR_EXISTING_API_KEY

{
  "text": "Brandon prefers documents as local Markdown files.",
  "reason": "Clarify the owner's name using Brandon's 2026-10-27 identity statement."
}
```

The example illustrates a request; it is not evidence that such a record exists. Do not copy its text over an unrelated fact. For a factual rollback, restore the saved original text/context/entities through the supported API and let derived knowledge rebuild again. A database backup is the rollback for a full source-reprocessing job.

For widespread wrong-subject extraction, prefer fixing the missions first, then planning reprocessing of the original source documents. Reprocessing can replace facts and affect curated edits; inventory documents and overrides before doing it. Avoid direct SQL replacement, which would bypass the memory API's derived-data maintenance.

## 4. Check the three layers separately

| Layer                               | Expected result                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| A newly retained personal statement | Extracted fact names Brandon as its subject                                            |
| A corrected old fact                | Text and relevant entity association identify Brandon; meaning and dates remain intact |
| Refreshed observations and models   | Summaries use Brandon and still distinguish other subjects                             |

The `user` key in a transcript role, an API schema, or generic technical prose can remain. The defect being corrected is a generic identity in personal knowledge, not every occurrence of those four letters.

The model-creation script does not perform identity cleanup. Apply fact corrections and bank-mission changes separately using the supported Hindsight interfaces.
