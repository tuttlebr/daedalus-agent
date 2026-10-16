"""Capture acknowledged-write cache behavior from the pinned PyMilvus SDK."""

import argparse
import hashlib
import inspect
import json
from pathlib import Path


def main(args):
    import pymilvus
    from pymilvus.client.cache import CollectionTsCache

    cases = []

    def capture(name, capacity, operations):
        cache = CollectionTsCache(capacity)
        steps = []
        for operation in operations:
            step = list(operation)
            if step[0] == "fill":
                for index in range(step[1]):
                    cache.set("synthetic-server", "", f"c{index}", index + 2)
            elif step[0] == "set":
                cache.set(*step[1:])
            else:
                step.append(cache.get(*step[1:]))
            steps.append(step)
        cases.append({"name": name, "capacity": capacity, "steps": steps})

    capture(
        "namespace-and-monotonicity",
        4096,
        [
            ["get", "synthetic-server", "", "a"],
            ["set", "synthetic-server", "", "a", 0],
            ["get", "synthetic-server", "default", "a"],
            ["set", "synthetic-server", "", "a", 10],
            ["get", "synthetic-server", "default", "a"],
            ["get", "other-server", "default", "a"],
            ["get", "synthetic-server", "other-db", "a"],
            ["get", "synthetic-server", "default", "other-collection"],
            ["set", "synthetic-server", "default", "a", 5],
            ["get", "synthetic-server", "", "a"],
            ["set", "synthetic-server", "", "a", 2**64 - 1],
            ["set", "synthetic-server", "", "a", 11],
            ["get", "synthetic-server", "default", "a"],
        ],
    )
    capture(
        "older-acknowledgement-touches-lru",
        3,
        [
            ["fill", 3],
            ["set", "synthetic-server", "default", "c0", 0],
            ["set", "synthetic-server", "", "c3", 5],
            ["get", "synthetic-server", "", "c1"],
            ["get", "synthetic-server", "", "c2"],
            ["get", "synthetic-server", "", "c0"],
            ["set", "synthetic-server", "", "c4", 6],
            ["get", "synthetic-server", "", "c3"],
        ],
    )
    capture(
        "default-capacity-and-read-touches",
        4096,
        [
            ["fill", 4096],
            ["get", "synthetic-server", "", "missing"],
            ["get", "synthetic-server", "", "c0"],
            ["set", "synthetic-server", "default", "c4096", 5000],
            ["get", "synthetic-server", "default", "c0"],
            ["get", "synthetic-server", "", "c1"],
            ["get", "synthetic-server", "", "c2"],
            ["set", "synthetic-server", "", "c4097", 5001],
            ["get", "synthetic-server", "", "c3"],
            ["get", "synthetic-server", "", "c4096"],
        ],
    )
    args.output.write_text(
        json.dumps(
            {
                "pymilvus": pymilvus.__version__,
                "python_image": args.python_image,
                "cache_sha256": hashlib.sha256(
                    inspect.getsource(CollectionTsCache).encode()
                ).hexdigest(),
                "exporter_sha256": hashlib.sha256(
                    Path(__file__).read_bytes()
                ).hexdigest(),
                "cases": cases,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--python-image", required=True)
    main(parser.parse_args())
