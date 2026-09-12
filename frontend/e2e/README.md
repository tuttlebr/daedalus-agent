# Browser test environment

`npm run e2e` requires Docker Compose, OpenSSL, Node 22 and the pinned Playwright
browsers. The runner builds the production application and creates disposable
Redis and object-store services with test credentials.

The browser opens `https://127.0.0.1:15000`. A loopback TLS proxy forwards HTTP
requests to the standalone Next server on 15002 and real WebSocket upgrades to
the sidecar on 15001. The build uses `wss://127.0.0.1:15000`; restart/outage tests
still stop and start the actual sidecar. A one-day synthetic certificate is
created in an OS temporary directory and removed during harness shutdown. Only
the Playwright context and readiness probe ignore this test certificate's trust
error. Chromium service-worker requests additionally trust only this run's
certificate public-key fingerprint. Production Secure cookies and application
TLS settings are unchanged.

Real login helpers check `/api/auth/me` from the browser after navigation; cached
UI identity alone cannot satisfy session acceptance. The browser suite also
checks service-worker control and observes actual WebSocket chat frames. Design
fixtures that explicitly mock authentication remain isolated UI tests.

Use `E2E_SKIP_BUILD=1` only with artifacts built using the same secure WebSocket
URL and current source. The default runner removes its Compose services and
volumes afterward; `E2E_KEEP_SERVICES=1` retains them for local diagnosis. Tests
never require production credentials or deployment access.
