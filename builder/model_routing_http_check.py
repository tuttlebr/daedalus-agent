#!/usr/bin/env python3
"""Compatibility entrypoint for the current Rust runtime HTTP contract checks."""

import argparse

from runtime_http_check import check

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image")
    args = parser.parse_args()
    check(image=args.image, redis_image=args.redis_image)
