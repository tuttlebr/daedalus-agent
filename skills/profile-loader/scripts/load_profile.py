"""Load profile data into Redis as native JSON documents.

Each profile section is stored as a separate RedisJSON document under
the key pattern: profile:<user_id>:<section_name>

This enables JSONPath queries like:
    JSON.GET profile:tuttlebr:identity $.full_name
    JSON.GET profile:tuttlebr:health_and_medications $.medications[0].name
"""

import json
import os
import re
import sys

_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]+$")
_SECTION_KEY_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]+$")


def check_redisjson(r) -> bool:
    import redis

    try:
        r.execute_command("JSON.SET", "__rj_probe__", ".", '"ok"')
        r.delete("__rj_probe__")
        return True
    except redis.exceptions.ResponseError:
        return False


def _load_profile(profile_path: str) -> dict:
    with open(profile_path) as f:
        profile = json.load(f)

    user_id = profile.get("user_id")
    if not isinstance(user_id, str) or not _USER_ID_PATTERN.match(user_id):
        print(f"ERROR: Invalid user_id: {user_id!r}", file=sys.stderr)
        sys.exit(1)

    sections = profile.get("sections")
    if not isinstance(sections, dict) or not sections:
        print("ERROR: profile sections must be a non-empty object.", file=sys.stderr)
        sys.exit(1)

    invalid_sections = [
        key
        for key in sections
        if not isinstance(key, str) or not _SECTION_KEY_PATTERN.match(key)
    ]
    if invalid_sections:
        print(
            f"ERROR: Invalid section key(s): {', '.join(map(repr, invalid_sections))}",
            file=sys.stderr,
        )
        sys.exit(1)

    return profile


def main() -> None:
    redis_host = os.environ.get("RI_REDIS_HOST_DAEDALUS", "redis")
    redis_port = int(os.environ.get("REDIS_PORT", "6379"))
    redis_db = int(os.environ.get("REDIS_DB", "0"))
    dry_run = os.environ.get("DAEDALUS_PROFILE_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }

    script_dir = os.path.dirname(os.path.abspath(__file__))
    profile_path = os.path.join(script_dir, "..", "assets", "profile-data.json")

    profile = _load_profile(profile_path)

    user_id = profile["user_id"]
    sections = profile["sections"]
    profile_version = profile.get("profile_version")

    if dry_run:
        print(
            f"DRY RUN: validated {len(sections)} profile sections for user "
            f"{user_id!r}."
        )
        if profile_version:
            print(f"Profile version: {profile_version}")
        for section_key in sections:
            print(f"  WOULD SET profile:{user_id}:{section_key}")
        return

    import redis

    r = redis.Redis(
        host=redis_host, port=redis_port, db=redis_db, decode_responses=True
    )
    r.ping()

    if not check_redisjson(r):
        print(
            "ERROR: RedisJSON module not loaded. Cannot store native JSON.",
            file=sys.stderr,
        )
        sys.exit(1)

    loaded = 0
    for section_key, section_data in sections.items():
        redis_key = f"profile:{user_id}:{section_key}"
        r.execute_command("JSON.SET", redis_key, "$", json.dumps(section_data))
        loaded += 1
        print(f"  SET {redis_key}")

    print(f"\nLoaded {loaded} profile sections for user '{user_id}' as native JSON.")
    if profile_version:
        print(f"Profile version: {profile_version}")


if __name__ == "__main__":
    main()
