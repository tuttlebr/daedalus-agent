# Alarm and event coverage

The connected integration-API server's current operation set does not expose
legacy alarm/event-list tools. Do not invent them or convert missing alarm data
into a zero count. State that alarm history was unavailable when it matters to
the health request.

If the user supplies an alarm export or another connected source exposes one,
record that source and as-of time. Interpret its actual schema, severity,
resolved/acknowledged state and timestamps. Do not apply legacy event-code
mappings to an unrelated payload.

Correlate an old loss-of-contact event with current adopted-device state and
client impact. A recovered event does not remain an active outage. Conversely,
absence of an alarm does not prove network health.

Report current impact first and propose a bounded diagnostic next step. Never
acknowledge/delete an alarm, reboot a device or change configuration as part of
this read-only health check.
