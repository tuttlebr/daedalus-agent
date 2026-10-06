# Content Credentials

`make deploy` prepares and validates signing material under
`$HOME/.config/daedalus/content-credentials` by default. Use
`DEPLOY_ARGS='--content-credentials-dir /your/private/directory'` to select an
existing directory. The chart mounts only the certificate and private key
required by the backend. Keep private signing files out of Git and logs.

The application signs final generated Chat and Create images using the creator
name `Brandon Tuttle` and the application labels `Daedalus Agent` and
`Daedalus-Create`. It excludes prompts, account identifiers, session data, and
input/upload details from the manifest. This signing is separate from container
image signatures and provenance checks in the deployment path.

The Rust migration proxies the existing authenticated image API to its Python
implementation, including signing and verification. A deployment dry run
renders a placeholder signing Secret and does not create or read private keys.
