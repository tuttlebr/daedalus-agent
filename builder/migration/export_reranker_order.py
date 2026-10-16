"""Capture ranking order from the retained vLLM parser, including NaN scores."""

import argparse
import hashlib
import inspect
import itertools
import json
import random
import sys
from pathlib import Path


def main(args):
    from nat_helpers.vllm_reranker import parse_vllm_rerank_response

    randomizer = random.Random(7803)  # nosec B311 - reproducible synthetic scores
    cases = list(itertools.product([0.0, 1.0, 2.0, float("nan")], repeat=4))
    for size in [8, 16, 32, 63, 64, 65, 100, 128, 256]:
        cases.extend(
            [
                [randomizer.choice([0.0, 1.0, 2.0, float("nan")]) for _ in range(size)]
                for _ in range(50)
            ]
        )
    for size in [63, 64, 65, 128, 1024]:
        cases.extend(
            [
                list(map(float, range(size))),
                list(map(float, reversed(range(size)))),
                [1.0] * size,
                [
                    float("nan") if index % 64 == 0 else float(index % 11)
                    for index in range(size)
                ],
                [float("nan")] * size,
            ]
        )
    cases.extend(
        itertools.permutations([-float("inf"), float("nan"), float("inf"), -0.0, 0.0])
    )
    observed = []
    for scores in cases:
        result = parse_vllm_rerank_response(
            {
                "results": [
                    {"index": index, "relevance_score": score}
                    for index, score in enumerate(scores)
                ]
            },
            document_count=len(scores),
        )
        observed.append(
            {
                "scores": ",".join(map(str, scores)),
                "order": ",".join(str(item.index) for item in result),
            }
        )
    fixture = {
        "python": sys.version,
        "python_image": args.python_image,
        "parser_sha256": hashlib.sha256(
            inspect.getsource(parse_vllm_rerank_response).encode()
        ).hexdigest(),
        "exporter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "sort_reference": "https://github.com/python/cpython/blob/v3.12.3/Objects/listobject.c",
        "cases": observed,
    }
    args.output.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"Captured {len(observed)} retained ranking orders", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--python-image", required=True)
    main(parser.parse_args())
