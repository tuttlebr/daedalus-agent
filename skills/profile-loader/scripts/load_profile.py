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

import redis

_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]+$")


def check_redisjson(r: redis.Redis) -> bool:
    try:
        r.execute_command("JSON.SET", "__rj_probe__", ".", '"ok"')
        r.delete("__rj_probe__")
        return True
    except redis.exceptions.ResponseError:
        return False


def main() -> None:
    redis_host = os.environ.get("RI_REDIS_HOST_DAEDALUS", "redis")
    redis_port = int(os.environ.get("REDIS_PORT", "6379"))
    redis_db = int(os.environ.get("REDIS_DB", "0"))

    script_dir = os.path.dirname(os.path.abspath(__file__))
    profile_path = os.path.join(script_dir, "..", "resources", "profile-data.json")

    with open(profile_path) as f:
        profile = json.load(f)

    user_id = profile["user_id"]
    if not _USER_ID_PATTERN.match(user_id):
        print(f"ERROR: Invalid user_id: {user_id!r}", file=sys.stderr)
        sys.exit(1)
    sections = profile["sections"]

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


if __name__ == "__main__":
    main()
