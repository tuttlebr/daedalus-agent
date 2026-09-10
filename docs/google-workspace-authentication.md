# Google Workspace authentication for unattended tasks

Daedalus uses per-user Google OAuth offline grants for Gmail, Calendar, and
Docs. Consent is requested when a service has no usable grant. Access tokens
refresh automatically and the refresh token remains in the service's durable
Redis bucket across chats and backend restarts. Background jobs now use the
same stable NAT identity as Chat, so they reuse the connections authorized there.

## Upgrade existing connections

1. Deploy the updated backend, autonomous worker, and frontend images together.
2. In Google Cloud's **Google Auth Platform → Audience**, check the OAuth app's
   publishing status. External apps in **Testing** receive refresh tokens that
   expire after seven days for Workspace scopes. Use **In production** for
   ongoing automation, satisfying Google's applicable configuration and
   verification requirements. Internal apps are an option only within an
   eligible Workspace organization.
3. In Daedalus **Connections**, reconnect Gmail and Calendar once, then use each
   service in Chat and complete Google's consent prompt. Older Gmail/Calendar
   authorizations did not request offline access, so they cannot acquire a
   refresh token without new consent. Existing usable Docs grants can continue.
4. Run an unattended read after authorization and another after the original
   access token expires. Both should complete without an OAuth prompt. Confirm
   the backend logs `Refreshed Google Workspace access token without interactive
consent` for the latter. Connection cards report saved records, not live
   verification of Google's acceptance.

Changing a Google project's publishing status cannot be done by changing a
Daedalus environment variable. If the status was Testing, obtain new grants
after changing it; do not assume an old seven-day grant becomes long-lived.

Google's [offline-access guide](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
describes refresh tokens and renewed consent. Its
[refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
cover Testing, revocation, Gmail password changes, inactivity, token limits,
time-limited consent, and administrator policy. These can still require a new
sign-in; automatic refresh cannot override them.

## Runtime behavior

- Authorization requests include `access_type=offline`,
  `include_granted_scopes=true`, and `prompt=consent` for the configured Gmail,
  Calendar, and Docs resources. Consent parameters apply only to an interactive
  flow; normal calls reuse saved credentials.
- Refresh uses an asynchronous OAuth client, the unwrapped client secret, and
  the configured token-endpoint authentication method. It retains refresh
  tokens when Google omits them and accepts explicit rotation.
- A 401 for the saved access token expires that access token while retaining
  its refresh token. A delayed 401 for an older token leaves a newer record alone.
- Token-endpoint timeouts, throttling, and server errors receive one bounded
  retry. Exhaustion or client misconfiguration fails the call while retaining
  the saved grant. It does not launch a consent flow. `invalid_grant` or a missing
  refresh token may require consent.
- The queue owner remains the authenticated username. Its NAT cookie follows
  Chat's `daedalus-user-<first 32 hex characters of sha256(username)>` contract.
  Users and service buckets remain separate. Background mutation approval rules
  continue to apply; reusable authentication does not grant action approval.

No existing token records are deleted or copied between users during this
upgrade. Old records associated with the worker's former username-based NAT
identity remain untouched; the worker now uses Chat's identity.

## Validation

`builder/google_workspace_oauth_contract_check.py` runs during the backend image
build through `runtime_contract_check.py`. It uses the installed NAT and Authlib
packages and their real serialization and HTTP authorization code, replacing
only the token endpoint with an in-process HTTP transport. It checks offline
consent, repeated refresh without browser interaction, provider reconstruction,
user isolation, refresh-token retention/rotation, stale 401 handling, bounded
outages, and terminal grant/client failures. Unit tests additionally check the
Chat/worker identity contract and the consent parameters for each resource.

These offline checks establish runtime behavior; deployment plus actual Google
consent and a successful unattended refresh establish live operation.
