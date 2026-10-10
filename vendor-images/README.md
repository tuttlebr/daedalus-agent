# Temporary upstream security rebuilds

The October 9, 2026 release scan found vulnerabilities in the retained nginx
and SeaweedFS images. These builds preserve their entrypoints and service
interfaces. They run only in Compose and disposable browser fixtures; Helm
uses the digest-pinned upstream unprivileged nginx slim image.

- nginx retains 1.31.5 and installs signed Alpine PCRE2 10.49-r0, fixing
  [CVE-2026-103111](https://github.com/PCRE2Project/pcre2/security/advisories/GHSA-r9hj-j2rw-4q3m).
- SeaweedFS retains release 4.46 and its existing runtime filesystem. Its Go
  executable is rebuilt from checksum-verified source with Go 1.26.9 and the
  pinned gRPC fix. The October 10 rescan also requires `golang.org/x/net` 0.60.0
  for [the HTTP/2 SETTINGS issue](https://pkg.go.dev/vuln/GO-2026-6611).
  `go.mod` and `go.sum` retain that fix and its required Go module updates.
  This also fixes
  [the HTTP Range issue](https://pkg.go.dev/vuln/GO-2026-6609),
  [the TLS ECH issue](https://pkg.go.dev/vuln/GO-2026-6607), and
  [the gRPC issue](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj).
  Existing Rust executables in the upstream image are retained.
  The locked optional rclone and Go module tooling dependencies are also patched
  to 1.75.1 and 0.41.0 so the full source inventory passes its existing gate.

The central `deployment-images.json` inventory records every consuming service
and build directory. `scripts/check_image_inventory.py --scan-upstream` builds
and scans both amd64 and arm64 variants, checks actual architecture, and fails
on unadjudicated HIGH/CRITICAL findings or secrets. ARM patch builds require
QEMU/binfmt, installed by CI's existing pinned Docker action. This scan evidence
does not establish ARM application runtime support. No runtime package download
or new vulnerability exception is introduced.

For a local x86 Linux builder without ARM binfmt, install only that emulator:

```bash
docker run --privileged --rm mirror.gcr.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64
```

The Dockerfiles use Google's Docker Hub mirror for the same digest-verified
base images to avoid anonymous Docker Hub rate limits during repeated checks.

The final six image/architecture scans passed on October 9, 2026. Both shipped
nginx configurations passed syntax checks. With disposable S3 state, the patched
SeaweedFS read baseline-written objects, and the baseline image read objects
written by the patch after rollback. The existing browser storage workflows
also passed against the patched image.

`.gitleaksignore` records one exact historical fingerprint for the public SHA-256
of the frozen `oauth.py` source. The source hash was verified against the baseline;
it is not a credential. Other secret findings continue to fail the gate.

Brandon Tuttle owns these temporary builds. They add local build/cache cost and
duplicate binary layers; they add no Kubernetes workload. Reconsider each at
the next upstream patch release and replace it with an immutable upstream image
after both architecture scans and the affected HTTP/object-storage tests pass.
The retained image's original license applies: nginx BSD-2-Clause and
SeaweedFS Apache-2.0; Go BSD-3-Clause and gRPC Apache-2.0.
