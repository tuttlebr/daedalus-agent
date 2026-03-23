---
name: profile-loader
description: Load user profile data into Redis as native JSON documents for personalized agent responses
---

# Profile Loader

Load user profile data into Redis as native JSON documents using `JSON.SET`.

## When to use

Run this skill when the user asks to load, reload, or refresh their profile data in Redis. This stores each profile section as a separate RedisJSON document, enabling JSONPath queries against the data.

## What it does

The `load_profile.py` script reads `resources/profile-data.json` and writes each section to Redis under keys following the pattern `profile:<user_id>:<section_name>`.

After loading, data is queryable with commands like:

```
JSON.GET profile:tuttlebr:identity $.full_name
JSON.GET profile:tuttlebr:professional_profile $.key_skills
JSON.GET profile:tuttlebr:health_and_medications $.medications[*].name
```

## How to run

Call `run_skill_script` with:
- skill_name: `profile-loader`
- script_name: `load_profile.py`

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

- RedisJSON module must be loaded on the target Redis instance.
- Environment variables `RI_REDIS_HOST_DAEDALUS` and `REDIS_PORT` must be set (defaults to `redis:6379`).
