#!/usr/bin/env python3
"""Run a candidate image and scripted external peers for browser tests."""

import argparse
import signal
import threading

from image_check import environment

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", required=True)
parser.add_argument("--redis-image", required=True)
parser.add_argument("--port", type=int, default=18000)
args = parser.parse_args()
stopped = threading.Event()
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: stopped.set())
with environment(  # nosec B106 - browser fixture token, no real account
    args.image,
    args.redis_image,
    memory=False,
    port=args.port,
    token="e2e-internal-token",
):
    print("Candidate image ready; mock backend is disabled.", flush=True)
    stopped.wait()
