# Temporary upstream security rebuilds

These nginx and SeaweedFS rebuilds pin patched dependencies while preserving
the upstream entrypoints and service interfaces. The Compose nginx and SeaweedFS
rebuilds run only in Compose and disposable browser fixtures. The Helm nginx
rebuild is a release image: it is built, scanned, signed and published with the
backend, frontend and Redis images and deployed as the chart's `images.nginx`.

All three runtime rebuilds install signed Alpine musl and musl-utils 1.2.6-r3
to fix [CVE-2026-107891](https://security.alpinelinux.org/vuln/CVE-2026-107891).
The frontend image also requires at least these patched package versions.

- Helm nginx (`nginx-unprivileged/`, Compose service `nginx-helm` in the
  release-only profile) retains the unprivileged 1.31.6 Alpine slim image and
  installs signed Alpine zlib 1.4-r0, fixing CVE-2026-85091 and CVE-2026-4738.
  It runs as the upstream user 101 with the upstream entrypoint, ports 8080/8443
  and configuration paths, so the chart's non-root, read-only security context
  is unchanged.
- Compose nginx retains 1.31.5 and installs signed Alpine PCRE2 10.49-r0, fixing
  [CVE-2026-103111](https://github.com/PCRE2Project/pcre2/security/advisories/GHSA-r9hj-j2rw-4q3m),
  and zlib 1.4-r0, fixing CVE-2026-85091 and CVE-2026-4738.
- SeaweedFS retains release 4.46 and its existing runtime filesystem, with signed
  Alpine runtime packages pinned to Brotli 1.2.1-r0, curl/libcurl 8.23.0-r0 and
  zlib 1.4-r0 (CVE-2026-85091 and CVE-2026-4738).
  Its Go executable is rebuilt from checksum-verified source with Go 1.26.10, which
  fixes [the standard library issue](https://pkg.go.dev/vuln/GO-2026-6809),
  and the pinned gRPC fix. The build pins `golang.org/x/net` 0.60.0
  for [the HTTP/2 SETTINGS issue](https://pkg.go.dev/vuln/GO-2026-6611).
  `go.mod` and `go.sum` retain that fix and its required Go module updates.
  This also fixes
  [the HTTP Range issue](https://pkg.go.dev/vuln/GO-2026-6609),
  [the TLS ECH issue](https://pkg.go.dev/vuln/GO-2026-6607), and
  [the gRPC issue](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj).
  Existing Rust executables in the upstream image are retained.
  The locked optional rclone and Go module tooling dependencies are also patched
  to 1.75.1 and 0.41.0 so the full source inventory passes its existing gate.
  Go JOSE is pinned to 4.1.6 for
  [bounded RSA JWK parsing](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q).

The central `deployment-images.json` inventory records every consuming service
and build directory; built services that declare a `context` are vendor
rebuilds. `scripts/check_image_inventory.py --scan-upstream` builds
and scans both amd64 and arm64 variants of every rebuild, checks actual architecture, and fails
on unadjudicated HIGH/CRITICAL findings or secrets. ARM patch builds require
QEMU/binfmt, installed by CI's existing pinned Docker action. This scan evidence
does not establish ARM application runtime support. Dependencies are installed at build time; runtime containers do not download
packages.

For a local x86 Linux builder without ARM binfmt, install only that emulator:

```bash
docker run --privileged --rm mirror.gcr.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64
```

The Dockerfiles use Google's Docker Hub mirror for the same digest-verified
base images to avoid anonymous Docker Hub rate limits during repeated checks.

Validate each nginx configuration with its image's syntax check; for Helm,
render the chart's `frontend.conf` with and without `nginx.https.enabled` and
run `nginx -t` as user 101 with it mounted at `/etc/nginx/conf.d/default.conf`. Exercise
SeaweedFS against disposable S3 state: each candidate must read objects written
by its baseline, and the baseline must read candidate-written objects after
rollback. Run the browser storage workflows against the candidate as well.
Keep scan and compatibility results with release evidence outside this guide.

`.gitleaksignore` records only exact fingerprints of reviewed non-credential
matches, each annotated with its provenance. Other secret findings continue to
fail the gate.

Brandon Tuttle owns these temporary builds. They add local build/cache cost and
duplicate binary layers. The Helm nginx rebuild adds no workload; it replaces
the upstream image in the existing nginx Deployment and adds one image to each
release. Reconsider each at the next upstream patch release and replace it with
an immutable upstream image after both architecture scans and the affected
HTTP/object-storage tests pass. Returning Helm to upstream also removes
`nginx-helm` from the inventory's built services and every release path.
The retained images' original licenses apply: nginx BSD-2-Clause and
SeaweedFS Apache-2.0; Go BSD-3-Clause and gRPC Apache-2.0.
