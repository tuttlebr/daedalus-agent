#!/bin/bash
# Start Redis Stack server with JSON support in the background
if command -v redis-stack-server &> /dev/null; then
    redis-stack-server --daemonize no --bind 0.0.0.0 --port 6379 --save "" --appendonly no
else
    # Fallback to regular redis-server with loadmodule if available
    redis-server --daemonize no --bind 0.0.0.0 --port 6379 --save "" --appendonly no --loadmodule /usr/lib/redis/modules/rejson.so 2>/dev/null || \
    redis-server --daemonize no --bind 0.0.0.0 --port 6379 --save "" --appendonly no
fi
