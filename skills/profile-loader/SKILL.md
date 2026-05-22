---
name: profile-loader
description: Load user profile data into Redis as native JSON documents (via JSON.SET) so the personalized agent stack can query it with JSONPath. Use whenever the user asks to "load my profile into Redis", "refresh my profile data", "reseed profile sections", "run load_profile", "update my profile-data.json", or otherwise wants the JSON sections under `assets/profile-data.json` written to `profile:<user_id>:<section>` Redis keys. Backed by the bundled `scripts/load_profile.py` script invoked via `run_skill_script`.
---

# Profile Loader

Load user profile data into Redis as native JSON documents using `JSON.SET`.

## When to use

Run this skill when the user asks to load, reload, or refresh their profile data in Redis. This stores each profile section as a separate RedisJSON document, enabling JSONPath queries against the data.

## What it does

The `scripts/load_profile.py` script reads `assets/profile-data.json` and writes each section to Redis under keys following the pattern `profile:<user_id>:<section_name>`.

After loading, data is queryable with commands like:

```
JSON.GET profile:tuttlebr:identity $.full_name
JSON.GET profile:tuttlebr:professional_profile $.key_skills
JSON.GET profile:tuttlebr:health_and_medications $.medications[*].name
```

## Verifying the load

After running the script, confirm the expected keys exist:

```
# Count + list keys for this user
redis-cli --scan --pattern "profile:<user_id>:*"
redis-cli --scan --pattern "profile:<user_id>:*" | wc -l

# Spot-check a specific section
redis-cli JSON.GET profile:<user_id>:identity $.full_name
redis-cli JSON.GET profile:<user_id>:communication_style
```

The script prints `Loaded N profile sections for user '<user_id>' as native JSON.` on success — N should match the section count in your JSON.

**Idempotency note**: re-running overwrites prior keys for sections that exist in the current JSON, but does **not** delete sections that were removed since the previous load (Redis JSON.SET is per-key, not a bulk replace). If you need strict sync — e.g. you deleted a section from the JSON and want it gone from Redis — clear keys first:

```
redis-cli --scan --pattern "profile:<user_id>:*" | xargs -r redis-cli DEL
```

## How to run

Call `run_skill_script` with:
- `skill_name`: `profile-loader`
- `script`: `scripts/load_profile.py`

(Requires `allow_script_execution: true` on the backend `agent_skills_tool`, which is enabled in the current production config.)

## Input format

The script reads `assets/profile-data.json` (relative to the skill directory). The file must contain a top-level object with two required fields:

- `user_id` (string): The Redis key prefix. Must match `^[a-zA-Z0-9_.-]+$` — alphanumerics, dot, underscore, hyphen only. Invalid IDs cause the script to exit with an error. **The script has no CLI override** — `user_id` is read from the JSON file itself. If you want a different prefix, edit the JSON, don't try to pass a flag.
- `sections` (object): A map of section name → arbitrary JSON. Each entry becomes a Redis key `profile:<user_id>:<section_name>`. The section names listed in the table below are conventional — additional sections are loaded as-is.

Minimal example:

```json
{
  "user_id": "tuttlebr",
  "sections": {
    "identity": {
      "full_name": "Brandon Tuttle",
      "email": "btuttle@nvidia.com"
    },
    "communication_style": {
      "framework": "BLUF",
      "verbosity": "concise"
    }
  }
}
```

The file is gitignored by convention since it contains personal data. Place it at `skills/profile-loader/assets/profile-data.json` before running the script.

## Sections stored

| Redis key | Content |
|---|---|
| `profile:<user_id>:identity` | Name, username, birthday, email |
| `profile:<user_id>:location_and_timezone` | Address, timezone, currency |
| `profile:<user_id>:communication_style` | BLUF framework, ADHD preferences |
| `profile:<user_id>:communication_preferences` | Verbosity, tone, disliked words |
| `profile:<user_id>:writing_tone_and_style` | PACE framework, voice rules |
| `profile:<user_id>:family` | Family members |
| `profile:<user_id>:health_and_medications` | Medications (sensitive) |
| `profile:<user_id>:travel_preferences` | Airlines, airports, hotels |
| `profile:<user_id>:professional_profile` | Employer, skills, links |
| `profile:<user_id>:interests_and_hobbies` | Topics, sports, music |
| `profile:<user_id>:learning_preferences` | Tools, code style |
| `profile:<user_id>:daily_briefing_procedure` | Briefing steps and triggers |
| `profile:<user_id>:personal_values_and_boundaries` | Sensitivity rules |
| `profile:<user_id>:feedback_and_improvement` | Feedback preferences |
| `profile:<user_id>:source_code_projects` | GitHub project list |

## Requirements

- **RedisJSON module** must be loaded on the target Redis instance. The script probes `JSON.SET` at startup and exits non-zero with a clear stderr message (`ERROR: RedisJSON module not loaded.`) if the module is missing — no need to pre-check manually.
- **Environment variables**:
  - `RI_REDIS_HOST_DAEDALUS` — Redis host (default `redis`)
  - `REDIS_PORT` — Redis port (default `6379`)
  - `REDIS_DB` — Redis logical DB index (default `0`)
- `redis-py` available in the Python environment running the script.
