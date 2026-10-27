# Hindsight Mental Models for Brandon

Eight focused model templates for Daedalus's existing personal memory bank, with copy/paste queries, a standard-library Python loader, and an identity-correction procedure. The loader previews requests offline by default and creates missing entries only with `--apply`.

The catalog targets Brandon's bank. Before adapting it to another person, update the names and ownership context in both `models.json` and `mental-models.md`; an unscoped query should only be used in that person's private bank.

## Files

| File                                               | Use                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [mental-models.md](mental-models.md)               | Complete names and source queries to copy into Hindsight's UI                                  |
| [models.json](models.json)                         | The same definitions in machine-readable form                                                  |
| [create_models.py](create_models.py)               | Python 3 standard-library loader; previews offline unless given `--apply`                      |
| [identity-and-cleanup.md](identity-and-cleanup.md) | Establish Brandon's identity, improve future extraction, and correct existing owner references |

## Recommended starting set

| Model                    | What it contributes                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `brandon-identity`       | Brandon's identity, aliases, and relevant stable personal context                      |
| `brandon-corrections`    | Explicit corrections, their scope, and superseded guidance                             |
| `brandon-infrastructure` | Client paths, service dependencies, compatibility requirements, and dated verification |
| `brandon-verification`   | Lessons about diagnosis, evidence, and what proves work is complete                    |

The optional models cover communication and deliverables, research and briefings, technical decision rationale, and successful workflow lessons. Start with the identity model, inspect its output, then add the rest of the starter set. A narrow model with little evidence should say what is unknown; it should not manufacture a profile.

Daedalus already bootstraps **User Profile & Preferences**, **Active Projects, Decisions & Blockers**, and **Reusable Procedures & Constraints**. These drafts add more specific retrieval targets. Review overlap after generation; there is no need to create every model or replace the existing three. The loader leaves existing entries untouched.

## How these reach Daedalus

Normal memory preparation searches Hindsight's Knowledge Base and reads at most two matching pages, clipping each body to 1,800 characters. It falls back to facts when no page is found. The source queries therefore request short summaries with their most useful findings first. See [`memory.rs`](../../builder/runtime/src/memory.rs).

The loader defaults to `--kind knowledge-page`. A Hindsight Knowledge Page has a backing Mental Model and is discoverable through that existing chat path. This refers to Hindsight's self-hosted feature; these local files do not use ChatGPT Pages or Spaces. [Hindsight Knowledge Pages API](https://hindsight.vectorize.io/developer/api/knowledge-pages)

Use `--kind mental-model` for standalone Mental Models. Hindsight Reflect can consult those, but Daedalus does not directly fetch standalone model IDs during routine preparation. Do not assume creating one makes its content appear on every turn. In the current runtime, reflection is conditional, and protected read-only preparation does not run it. [Hindsight Mental Models API](https://hindsight.vectorize.io/developer/api/mental-models)

The custom page configuration deliberately uses full regeneration, all three fact types, and excludes sibling models. That lets direct identity facts participate and limits circular summaries. These are overrides of Hindsight's default page settings, not claims about those defaults.

## Copy/paste route

1. Open Brandon's existing bank in the Hindsight UI. Do not create a new bank named `Brandon` merely to match the display name.
2. Save the identity note in [identity-and-cleanup.md](identity-and-cleanup.md) as a memory and allow retention to finish.
3. Open [mental-models.md](mental-models.md). For each desired entry, copy its name and entire source-query block into the creation form.
4. Prefer a Hindsight Knowledge Page for routine Daedalus retrieval; use the Mental Models form for a standalone model. Available controls depend on the installed Hindsight version.
5. Leave tags empty in Brandon's existing private bank. Topic tags invented here would filter out older memories lacking those tags. The source query selects the topic. [Hindsight tag filtering](https://hindsight.vectorize.io/developer/api/mental-models#tags-and-visibility)
6. Start with manual refresh. Inspect the completed content and evidence before enabling automatic refresh. Refreshing rewrites model content from memory; it does not import these Markdown files as facts.

## Script route

From `tools/hindsight-mental-models/`:

```bash
# Offline preview of the four starter models. No URL, key, or bank is needed.
python3 create_models.py

# Preview just the identity model, or every model.
python3 create_models.py --select brandon-identity
python3 create_models.py --all

# Preview standalone Mental Models instead of their Knowledge Page form.
python3 create_models.py --kind mental-model --all
```

To create entries, configure the **existing Hindsight API** and **existing bank ID**:

```bash
export HINDSIGHT_API_URL='https://YOUR_EXISTING_HINDSIGHT_API'
export HINDSIGHT_BANK_ID='YOUR_EXISTING_BANK_ID'

# If the API uses authentication, enter its existing key without shell-history exposure.
read -rsp 'Hindsight API key: ' HINDSIGHT_API_KEY
printf '\n'
export HINDSIGHT_API_KEY

python3 create_models.py --select brandon-identity --apply
```

The API URL is the service base URL, before `/v1/default/banks/...`. Use a currently working endpoint; this script does not change ports, routes, or access controls. Daedalus derives its `du-...` bank ID from the authenticated identity, not the display name; copy the existing ID from Hindsight instead of guessing it.

After reviewing the identity model, create the remaining starter models:

```bash
python3 create_models.py --apply

# Alternatively, enable refresh after consolidation for NEW entries at creation:
python3 create_models.py --select brandon-research,brandon-workflows --auto-refresh --apply
```

`--auto-refresh` sets a one-hour minimum interval between automatic refreshes. Without it, entries refresh manually. Each refresh uses Hindsight's configured model and can consume tokens; eight automatically refreshed models are eight separate synthesis jobs. [Hindsight refresh controls](https://hindsight.vectorize.io/developer/api/mental-models#automatic-refresh)

The loader lists existing models, including page-backed models, and skips matching IDs or names. It never updates, deletes, or converts existing entries. To change an existing query or its refresh policy, edit that entry in Hindsight and refresh it; rerunning with `--auto-refresh` will not modify a skipped entry. Avoid running two copies simultaneously.

Creation returns operation IDs before content is ready. The script prints those receipts and stops on errors without retrying writes. Inspect Hindsight operations and generated content before rerunning after an interruption. It requires the API fields in the referenced current docs; an older server may reject a setting. Verify compatibility with the installed Hindsight version before relying on generated content.

## Review the generated results

Use these as acceptance checks, not assertions that generation has already passed:

- Owner references say **Brandon**; generic users, quoted speakers, and other people remain distinct.
- Corrections retain their actual scope and dates. A historical permission is not treated as today's authorization.
- Infrastructure entries preserve supported client paths and distinguish a past successful test from current health.
- Claims have evidence. Empty topics remain empty; proposed work is not reported as completed.
- Important content survives the first 1,800 characters, and unrelated models do not duplicate each other.
- In Daedalus, a relevant request can retrieve the new page. The fact-recall tool alone is not proof that a Mental Model was used.

For example: ask about Brandon's established requirements when hardening his home services, then compare the supplied memory context with the infrastructure page. Treat model content as evidence, consistent with the runtime's existing memory boundary.

## Maintaining the templates

Keep each `source_query` in `models.json` identical to its copy/paste block in `mental-models.md`. The catalog's `starter` field chooses the default subset; `--all` includes every entry.

After changing the catalog or loader, preview both API forms and check the request bodies against the installed Hindsight API:

```bash
python3 create_models.py --all
python3 create_models.py --kind mental-model --all
python3 create_models.py --select brandon-identity --auto-refresh
```

Verify that the default preview sends no requests, an existing ID or name is skipped, pagination reaches all existing entries, and a failed write stops without retrying. Live generation also requires checking the returned operation and resulting content in Hindsight. Keep API keys, bank exports, and generated personal summaries outside tracked files.
