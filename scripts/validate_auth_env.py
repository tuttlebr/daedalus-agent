#!/usr/bin/env python3
"""Validate deployment authentication settings without exposing credentials."""

from __future__ import annotations

import re
import sys
from pathlib import Path

BCRYPT_HASH_PATTERN = re.compile(r"^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$")
NUMBERED_AUTH_PATTERN = re.compile(
    r"^AUTH_USER_(\d+)_(USERNAME|PASSWORD_HASH|PASSWORD|NAME)$"
)
MINIMUM_BCRYPT_COST = 12


def load_env(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        entries[key] = value
    return entries


def validate_hash(label: str, password_hash: str) -> None:
    match = BCRYPT_HASH_PATTERN.fullmatch(password_hash)
    cost = int(match.group(1)) if match else 0
    if cost < MINIMUM_BCRYPT_COST:
        raise ValueError(
            f"{label} must use a bcrypt password hash with cost "
            f"{MINIMUM_BCRYPT_COST} or greater"
        )


def validate_auth(entries: dict[str, str]) -> int:
    plaintext_keys = [
        key
        for key, value in entries.items()
        if value
        and (key == "AUTH_PASSWORD" or re.fullmatch(r"AUTH_USER_\d+_PASSWORD", key))
    ]
    if plaintext_keys:
        raise ValueError(
            "plaintext authentication variables are unsupported: "
            + ", ".join(sorted(plaintext_keys))
            + "; generate each matching *_PASSWORD_HASH from the same current "
            "password; users do not need to change passwords"
        )

    numbered: dict[int, dict[str, str]] = {}
    for key, value in entries.items():
        match = NUMBERED_AUTH_PATTERN.fullmatch(key)
        if match:
            numbered.setdefault(int(match.group(1)), {})[match.group(2)] = value

    active_indices = sorted(
        index
        for index, values in numbered.items()
        if values.get("USERNAME") or values.get("PASSWORD_HASH")
    )
    fallback_active = bool(
        entries.get("AUTH_USERNAME") or entries.get("AUTH_PASSWORD_HASH")
    )

    if active_indices and fallback_active:
        raise ValueError(
            "configure either numbered AUTH_USER_* accounts or AUTH_USERNAME, not both"
        )

    users: list[tuple[str, str, str]] = []
    if active_indices:
        expected_indices = list(range(1, active_indices[-1] + 1))
        if active_indices != expected_indices:
            raise ValueError("numbered AUTH_USER_* accounts must be contiguous from 1")
        for index in active_indices:
            values = numbered[index]
            username = values.get("USERNAME", "")
            password_hash = values.get("PASSWORD_HASH", "")
            if not username or not password_hash:
                raise ValueError(
                    f"AUTH_USER_{index}_USERNAME and AUTH_USER_{index}_PASSWORD_HASH "
                    "must both be configured"
                )
            users.append((f"AUTH_USER_{index}_PASSWORD_HASH", username, password_hash))
    elif fallback_active:
        username = entries.get("AUTH_USERNAME", "")
        password_hash = entries.get("AUTH_PASSWORD_HASH", "")
        if not username or not password_hash:
            raise ValueError(
                "AUTH_USERNAME and AUTH_PASSWORD_HASH must both be configured"
            )
        users.append(("AUTH_PASSWORD_HASH", username, password_hash))
    else:
        raise ValueError(
            "configure AUTH_USERNAME with AUTH_PASSWORD_HASH, or contiguous "
            "numbered AUTH_USER_* accounts"
        )

    usernames = [username for _, username, _ in users]
    if len(usernames) != len(set(usernames)):
        raise ValueError("authentication usernames must be unique")

    for label, _, password_hash in users:
        validate_hash(label, password_hash)
    return len(users)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} ENV_FILE", file=sys.stderr)
        return 2
    try:
        count = validate_auth(load_env(Path(sys.argv[1])))
    except (OSError, ValueError) as exc:
        print(f"ERROR: Invalid authentication configuration: {exc}", file=sys.stderr)
        return 1
    print(f"Validated password-hash authentication for {count} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
