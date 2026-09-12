"""Physical retention must never round below the API's metadata lifetime."""

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/document_object_ttl.sh"
SECONDS = {"m": 60, "h": 3600, "d": 86400, "w": 604800, "M": 2592000, "y": 31536000}


@pytest.mark.parametrize(
    "seconds", [1, 60, 61, 15300, 15301, 604800, 604801, 31536000, 8041680000]
)
def test_rounds_up_to_representable_volume_ttl(seconds):
    value = subprocess.check_output(
        ["sh", str(SCRIPT), str(seconds)], text=True
    ).strip()
    count = int(value[:-1])
    assert 1 <= count <= 255
    assert count * SECONDS[value[-1]] >= seconds
    assert count * SECONDS[value[-1]] - seconds < SECONDS[value[-1]]


@pytest.mark.parametrize(
    "value", ["", "0", "-1", "1.5", "7d", "8041680001", "1;echo injected"]
)
def test_rejects_unsupported_or_injected_retention(value):
    result = subprocess.run(["sh", str(SCRIPT), value], capture_output=True, text=True)
    assert result.returncode != 0
    assert not result.stdout
