# Delivery-related incidents

Use `sre-engineer` for incident impact, timeline, communications drafts and
reliability decisions. Use this reference for failures tied to a build, image,
release, migration or deployment configuration.

Compare last known-good and failing revisions/digests, effective configuration,
reconciler status, dependency access, and the real failing request. Correlate
with the rollout time; temporal proximity alone does not prove causation.

Prepare the smallest evidence-backed fix or compatible rollback. Preserve
unrelated workloads, PVCs and Secret values. Do not delete database pods,
scale/restart automatically on an error threshold, or turn diagnosis into a
chaos experiment. Sending an incident notice is a separate external action.

After a requested repair, verify endpoint behavior and retained data, then state
what is recovered and what cause remains uncertain. Keep a concise timeline
and follow-up checks proportionate to the incident.
