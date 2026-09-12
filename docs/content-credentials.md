# Local Content Credentials

Daedalus uses your own private development certificate chain to sign final images
from Chat and Create, including edits. The supported modes are `off` and `local`.
Certificate generation and image signing work offline after the Python dependencies
are installed. No external signing or timestamp service is used.

The public attribution is **Brandon Tuttle**, the application is **Daedalus**, and
outputs are marked as AI-generated (`trainedAlgorithmicMedia`). Added metadata
excludes prompts, account/session details, input references, and uploaded images.
An existing embedded provider manifest is preserved, including its existing public
metadata. Uploaded edit-input history is not embedded or reconstructed.

Final PNG, JPEG, and WebP images retain their pixels, dimensions, transparency,
and format. Partials remain unsigned. An interrupted stream cannot promote its
last partial into a final. When signing is enabled, signing/validation failures
prevent delivery of that final image. Full downloads preserve the signed bytes;
re-encoded thumbnails and screenshots do not preserve credentials. Previously
stored images are not retroactively signed.

## Generate your certificate bundle

From the repository root, run:

```bash
uv run scripts/create_content_credentials.py
```

The script defaults to `$HOME/.config/daedalus/content-credentials` and attributes
images to Brandon Tuttle. It generates an ES256 private root CA and a separate
signing certificate issued by that CA. The root is self-signed; the image signer
is a leaf certificate, as required by the SDK. The script tests the actual
application signing function, verifies the embedded manifest, and checks that
signing preserved the sample image's pixels and transparency.

Without `--ensure`, the output directory must be new and outside the repository.
It has permissions `0700`; all output files are created with `0600`. No keys or
certificate contents are printed. The generator only manages local files; it
does not install a Secret, change the running app, or deploy.

For repeatable setup, use `uv run scripts/create_content_credentials.py --ensure`.
This checks the actual certificate dates, chain, creator, matching private key,
and a newly signed sample. Valid credentials are reused, even if the root key has
been moved offline. Missing or invalid credentials are replaced only after a new
bundle passes verification. An existing invalid bundle is preserved in a sibling
`content-credentials.backup-...` directory. Concurrent setup calls are serialized.
Derived environment/Helm settings are repaired without replacing valid keys.

| File                 | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `key.pem`            | Private key used by the backend to sign images                             |
| `chain.pem`          | Leaf signing certificate followed by the private root certificate          |
| `certificate.pem`    | Public leaf signing certificate                                            |
| `root-ca.pem`        | Public root certificate                                                    |
| `root-key.pem`       | Root CA private key; retain separately and offline, never mount in the app |
| `local.env`          | Ready-to-source environment settings pointing at the bundle                |
| `helm-values.yaml`   | Local signing settings with a unique Kubernetes Secret name                |
| `signed-example.png` | Sample signed by the application's actual signing code                     |
| `verification.json`  | Public fingerprints, expiry dates, and self-check result                   |

Optional settings:

```bash
uv run scripts/create_content_credentials.py \
  --output-dir "$HOME/.config/daedalus/content-credentials-v2" \
  --creator "Brandon Tuttle" \
  --days 365
```

The leaf certificate defaults to one year; the root lasts ten years. `--days`
accepts 1–3650 days. `--secret-name` can set a specific Kubernetes Secret name;
otherwise the name includes the certificate fingerprint to support safe rotation.
The certificate's organization field uses the supplied creator name for display.
This is your own assertion of identity, not third-party verification.

## Deploy with `make deploy`

The standard deployment path handles certificate configuration automatically:

```bash
make deploy
```

Before building or pushing images, `deploy.sh` runs the generator with `--ensure`.
After creating the namespace, it installs **only** `chain.pem` and `key.pem` in
the certificate fingerprint Secret. It then applies the generated Helm settings
after your normal values, enabling local signing for the backend. The same
settings are used for preflight rendering and the final Helm upgrade. A failure
to prepare credentials or install their Secret stops the deployment.

The deployment host needs `uv`; it installs the generator's declared Python
dependencies automatically. To use another local bundle directory:

```bash
CONTENT_CREDENTIALS_DIR="$HOME/.config/daedalus/my-image-credentials" make deploy
```

Direct `deploy.sh` invocations also support `--content-credentials-dir PATH`.
`./deploy.sh --dry-run` prints the planned setup with a placeholder Secret name
and does not generate, rotate, or install credentials.

Helm mounts `chain.pem` and `key.pem` read-only at `/etc/c2pa` in the backend.
The root private key is never installed. The frontend and autonomous worker do
not receive keys; their image requests go through the backend. The chart alone
defaults to `mode: 'off'`; `deploy.sh` enables signing through its generated
values overlay. This overrides `contentCredentials` in your normal values file.
No manual Secret installation or values-file merge is needed for `make deploy`.

## Run the backend locally

For a backend running directly on this machine, source the generated settings
before starting it:

```bash
source "$HOME/.config/daedalus/content-credentials/local.env"
```

The settings are `C2PA_SIGNING_MODE=local`, `C2PA_CREATOR_NAME`,
`C2PA_CERTIFICATE_FILE`, `C2PA_PRIVATE_KEY_FILE`, and `C2PA_SIGNING_ALGORITHM=es256`.
These environment variables must be present in the backend process; sourcing a
file does not change an already running process.

## Verification and renewal

The credentials provide verifiable signatures and tamper detection. Public
inspectors will report an **unrecognized issuer** because the root is private.
Our self-check reports **Valid**, not **Trusted**. No publicly trusted identity
or conformance certification is claimed. See the
[CAI test-certificate guidance](https://opensource.contentauthenticity.org/docs/signing/test-certs/).

Without an external trusted timestamp, validity over time depends on the signing
certificate's lifetime. Each deployment reuses currently valid credentials and
replaces expired ones with a new fingerprint Secret. There is no background
renewal: if the certificate expires between deployments, signing fails until the
next deployment or local credential refresh. To renew early, generate a bundle
in a new directory and deploy using `CONTENT_CREDENTIALS_DIR` pointing there.
Keep old certificates for historical inspection and Helm rollback; renewal does
not change images that were already signed. Old Secrets are retained.

After enabling signing, download a final image from both Chat and Create and
inspect the original file. Confirm creator attribution, AI source type, valid
signature/content binding, and the expected unrecognized issuer. The generated
`signed-example.png` can also be inspected before deployment.

Tests use fresh bundles from the same generator:

```bash
builder/.venv/bin/python -m pytest \
  builder/tests/test_create_content_credentials.py \
  builder/tests/test_content_credentials_deploy.py \
  builder/tests/test_content_credentials.py \
  builder/tests/test_content_credentials_helm.py \
  builder/tests/test_openai_images.py
```
