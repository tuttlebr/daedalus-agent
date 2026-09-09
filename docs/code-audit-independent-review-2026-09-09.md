# Independent behavior derivation — 2026-09-09

Authority: only `/volume2/daedalus/datasets/daedalus-agent/docs/code-audit-review-contracts-2026-09-09.md` plus the primary references linked below. I did not inspect application source, tests, the audit report, memories, previous conversation, or application helpers. No application files were changed. This artifact is the original independent reference; future corrections must be separate, identified amendments.

The expected outcomes below are semantic outcomes. The brief does not specify function signatures, HTTP status codes, Redis return conventions, concrete event names, or database field names. An adapter may translate those representations, but must retain the state and ordering constraints. Fixture keys such as `applied`, `idempotent`, and `authorized` are reference labels, not claims about an undocumented API's literal return value. Compare the full stored values, not just the labels.

## 1. Authentication lifetime

Let D = 86,400,000 ms, A = current stored activity time, R = request time, and W = the time a refresh becomes effective. I use the half-open lifetime `[A,A+D)`: a request at A+D has expired. This is the ordinary interpretation of “lasts 24 hours,” but the exact equality convention was not explicitly stated. Authorization checks session presence and expiry at the authorization decision; refresh due means **R−A > 60,000**, with equality excluded by “more than.” A successful refresh sets A to R and expiry to R+D, not W+D.

The refresh decision must use the current live record at W. A stale observation is not permission to recreate a deleted key, revive expired activity, reapply a throttled refresh, or overwrite a newer timestamp. In particular, R less than current A cannot lower A. A valid authorization snapshot may finish after logout, as expressly allowed by the brief. I also allow a previously authorized request to finish after expiry; that is an explicit interpretation of the same snapshot model, not a promise that authorization can first occur after expiry.

Threshold cases begin at A=1,000,000, expiry=87,400,000:

| Age   | Request R | Authorized now | Refresh   | Stored A | Stored expiry |
| ----- | --------- | -------------- | --------- | -------- | ------------- |
| 59999 | 1059999   | True           | not_due   | 1000000  | 87400000      |
| 60000 | 1060000   | True           | not_due   | 1000000  | 87400000      |
| 60001 | 1060001   | True           | refreshed | 1060001  | 87460001      |

Expiry boundary probes are independent initial states; do not let the first probe refresh the session before running the later probe.
| A | Request time | Initially authorized |
| --- | --- | --- |
| 0 | 86399999 | True |
| 0 | 86400000 | False |
| 0 | 86400001 | False |

### logout_between_observe_and_refresh

Initial record: `{"activity_ms":1000000,"expires_ms":87400000}`.

| Order | Operation/input                                            | Expected outcome                                                            |
| ----- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1     | `{"op":"authorize","request_ms":1060001}`                  | `{"authorized":true,"observed_activity_ms":1000000}`                        |
| 2     | `{"op":"logout","time_ms":1060002}`                        | `{"stored":null}`                                                           |
| 3     | `{"op":"refresh","request_ms":1060001,"apply_ms":1060003}` | `{"result":"missing_noop","stored":null,"current_request_may_finish":true}` |
| 4     | `{"op":"authorize","request_ms":1060004}`                  | `{"authorized":false,"stored":null}`                                        |

### expiry_between_observe_and_refresh

Initial record: `{"activity_ms":0,"expires_ms":86400000}`.

| Order | Operation/input                                              | Expected outcome                                                                                                                       |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"authorize","request_ms":86399999}`                   | `{"authorized":true,"observed_activity_ms":0}`                                                                                         |
| 2     | `{"op":"refresh","request_ms":86399999,"apply_ms":86400000}` | `{"result":"expired_noop","logical_session_valid":false,"activity_must_not_change":true,"current_request_may_finish_assumption":true}` |
| 3     | `{"op":"authorize","request_ms":86400001}`                   | `{"authorized":false}`                                                                                                                 |

### stale_request_after_newer_refresh

Initial record: `{"activity_ms":1000000,"expires_ms":87400000}`.

| Order | Operation/input                                                                 | Expected outcome                                                                                                              |
| ----- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"authorize","request_ms":1060001,"request_id":"older"}`                  | `{"authorized":true,"observed_activity_ms":1000000}`                                                                          |
| 2     | `{"op":"authorize_and_refresh","request_ms":1120023,"request_id":"newer"}`      | `{"authorized":true,"stored":{"activity_ms":1120023,"expires_ms":87520023}}`                                                  |
| 3     | `{"op":"refresh","request_ms":1060001,"apply_ms":1120024,"request_id":"older"}` | `{"result":"not_due_or_stale_noop","stored":{"activity_ms":1120023,"expires_ms":87520023},"current_request_may_finish":true}` |

### second_refresh_makes_first_observation_not_due

Initial record: `{"activity_ms":1000000,"expires_ms":87400000}`.

| Order | Operation/input                                            | Expected outcome                                                              |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1     | `{"op":"observe","request_ms":1100000}`                    | `{"observed_activity_ms":1000000}`                                            |
| 2     | `{"op":"refresh","request_ms":1080000,"apply_ms":1100001}` | `{"stored":{"activity_ms":1080000,"expires_ms":87480000}}`                    |
| 3     | `{"op":"refresh","request_ms":1100000,"apply_ms":1100002}` | `{"result":"not_due","stored":{"activity_ms":1080000,"expires_ms":87480000}}` |

An expired physical record may remain until cleanup or may already be absent due to TTL. These representations are equivalent only while future authorization rejects it and refresh cannot extend or recreate it. No requirement is inferred for eagerly deleting it. In the “second refresh” case, the older timestamp 1,080,000 belongs to an already pending request whose refresh completes after the 1,100,000 observation; this is a deliberate reordered completion schedule.

## 2. Job outcomes and pending authorization

Terminal means `status ∈ {success,failure}` **or** a finalization timestamp is present. A numeric timestamp zero is present. Null is not a timestamp under this reference; malformed values and null treatment need an explicit data contract if they are allowed. A missing job remains missing under every update.

Each effective live update or terminal transition has a linearization point. A read before another operation's terminal transition gives no right to write afterwards. Only the first terminal contender may change any terminal data. Metadata and authorization prompts are inside this protection, including updates that do not carry a status field. Concurrent contenders can choose either winner; one must win and the stored job must be exactly that winner's result. Test both possible serial orders rather than insisting on a particular scheduler winner.

The fixtures name pending requests `a17` and `b204`, with unequal prompts. Removing a matching request is a set subtraction by request identifier against the current stored set. Completing a17 leaves b204 and exposes b204; completing b204 first leaves and exposes a17. Either subsequent matching callback leaves no pending requests. The two concurrent callbacks must not restore a request removed by the other callback. Unknown and repeated callbacks change nothing.

The brief does not define metadata merge depth or a mandatory prompt clearing rule at finalization. Fixtures explicitly supply replacement metadata and explicitly clear prompts in each terminal candidate, so their expected whole-record results are unambiguous. A terminal job seeded with pending prompts must preserve them when later callbacks are ignored. Prompt selection among multiple remaining requests is unspecified; the chosen insertion-order convention does not affect these two-request cases.

### late_live_write_after_success

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                                                                                                                         | Result        | Full stored job                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}`                                                                                                          | applied       | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |
| 2     | `{"op":"live_patch","observed_before_terminal":true,"patch":{"status":"live","metadata":{"owner":"stale"},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}}` | terminal_noop | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                                                                                                                            | terminal_noop | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |

### live_then_success

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                | Result  | Full stored job                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","patch":{"metadata":{"owner":"live-before","empty":[[]]}}}`                                                                                          | applied | `{"status":"live","metadata":{"owner":"live-before","empty":[[]]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | applied | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}`                                                                                                                 |

### terminal_success_first

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                | Result        | Full stored job                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | applied       | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |
| 2     | `{"op":"finish","patch":{"status":"failure","finalized_at":91,"finalization_id":"win-f","metadata":{"winner":"failure","empty":[]},"pending":[],"visible_prompt":null}}` | terminal_noop | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |

### terminal_failure_first

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                | Result        | Full stored job                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `{"op":"finish","patch":{"status":"failure","finalized_at":91,"finalization_id":"win-f","metadata":{"winner":"failure","empty":[]},"pending":[],"visible_prompt":null}}` | applied       | `{"status":"failure","metadata":{"winner":"failure","empty":[]},"pending":[],"visible_prompt":null,"finalized_at":91,"finalization_id":"win-f"}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | terminal_noop | `{"status":"failure","metadata":{"winner":"failure","empty":[]},"pending":[],"visible_prompt":null,"finalized_at":91,"finalization_id":"win-f"}` |

### metadata_only_live

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                      | Result  | Full stored job                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","patch":{"metadata":{"owner":"changed","empty":[{},[]]}}}` | applied | `{"status":"live","metadata":{"owner":"changed","empty":[{},[]]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |

### metadata_only_after_terminal

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                | Result        | Full stored job                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | applied       | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |
| 2     | `{"op":"live_patch","patch":{"metadata":{"owner":"changed"}}}`                                                                                                           | terminal_noop | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}` |

### callbacks_a_then_b

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                               | Result  | Full stored job                                                                                                                                                                                                                    |
| ----- | --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"callback","request_id":"a17"}`  | applied | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}` |
| 2     | `{"op":"callback","request_id":"b204"}` | applied | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[],"visible_prompt":null}`                                                                                                                                   |

### callbacks_b_then_a

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                               | Result  | Full stored job                                                                                                                                                                        |
| ----- | --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"callback","request_id":"b204"}` | applied | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"callback","request_id":"a17"}`  | applied | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[],"visible_prompt":null}`                                                                                       |

### unknown_repeated_callback

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                  | Result       | Full stored job                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"callback","request_id":"unknown"}` | unknown_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"callback","request_id":"a17"}`     | applied      | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}`                         |
| 3     | `{"op":"callback","request_id":"a17"}`     | unknown_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}`                         |

### callback_then_terminal_then_callback

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                | Result        | Full stored job                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"callback","request_id":"b204"}`                                                                                                                                  | applied       | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | applied       | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}`                                       |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                   | terminal_noop | `{"status":"success","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null,"finalized_at":70,"finalization_id":"win-s"}`                                       |

### missing

Initial record: `null`.

| Order | Operation                                                                                                                                                                | Result       | Full stored job |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------- |
| 1     | `{"op":"live_patch","patch":{"metadata":{"new":true}}}`                                                                                                                  | missing_noop | `null`          |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}` | missing_noop | `null`          |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                   | missing_noop | `null`          |

### success_without_timestamp

Initial record: `{"status":"success","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                                                                                                                         | Result        | Full stored job                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","observed_before_terminal":true,"patch":{"status":"live","metadata":{"owner":"stale"},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}}` | terminal_noop | `{"status":"success","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}`                                                                                                          | terminal_noop | `{"status":"success","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                                                                                                                            | terminal_noop | `{"status":"success","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |

### failure_without_timestamp

Initial record: `{"status":"failure","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}`.

| Order | Operation                                                                                                                                                                                                                                                                         | Result        | Full stored job                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","observed_before_terminal":true,"patch":{"status":"live","metadata":{"owner":"stale"},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}}` | terminal_noop | `{"status":"failure","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}`                                                                                                          | terminal_noop | `{"status":"failure","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                                                                                                                            | terminal_noop | `{"status":"failure","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"}}` |

### live_with_timestamp_zero

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":0}`.

| Order | Operation                                                                                                                                                                                                                                                                         | Result        | Full stored job                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","observed_before_terminal":true,"patch":{"status":"live","metadata":{"owner":"stale"},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}}` | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":0}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}`                                                                                                          | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":0}` |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                                                                                                                            | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":0}` |

### live_with_timestamp_positive

Initial record: `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":2}`.

| Order | Operation                                                                                                                                                                                                                                                                         | Result        | Full stored job                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"op":"live_patch","observed_before_terminal":true,"patch":{"status":"live","metadata":{"owner":"stale"},"pending":[{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"b204","prompt":"approve longer unrelated operation"}}}` | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":2}` |
| 2     | `{"op":"finish","patch":{"status":"success","finalized_at":70,"finalization_id":"win-s","metadata":{"winner":"success","empty":{}},"pending":[],"visible_prompt":null}}`                                                                                                          | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":2}` |
| 3     | `{"op":"callback","request_id":"a17"}`                                                                                                                                                                                                                                            | terminal_noop | `{"status":"live","metadata":{"owner":"initial","empty":[]},"pending":[{"request_id":"a17","prompt":"approve short"},{"request_id":"b204","prompt":"approve longer unrelated operation"}],"visible_prompt":{"request_id":"a17","prompt":"approve short"},"finalized_at":2}` |

For simultaneous callbacks, arrange both observations before either write and release the writes in each order. For the stale live update case, hold its write until success has committed. This distinguishes an atomic condition on current storage from a preflight check against a stale object.

## 3. Finalization records and publication

The job winner and its recovery record must carry the same outcome and finalization identifier. Competing writers cannot leave success on the job and failure in the journal, or the correct status with the losing identifier/payload. The brief does not specify a separate return convention for “already won by me” versus “lost”; stored decision identity is decisive.

Here is the invariant payload, whose value must survive every phase update and every representation conversion:

```json
{
  "empty_array": [],
  "empty_object": {},
  "nested": [[], {}, [[], {}], [[[]]]],
  "low": 9007199254740990,
  "high": 9007199254740991,
  "order": [9007199254740991, 9007199254740990],
  "text": "Aé漢🙂z"
}
```

Arrays and objects are different JSON kinds, even when empty. Array order is meaningful; object member order is not. The integers 9,007,199,254,740,990 and 9,007,199,254,740,991 are distinct and both lie within the exact integer interoperability interval identified by [RFC 8259, section 6](https://www.rfc-editor.org/rfc/rfc8259.html#section-6). Rounding either number, converting either to a string, collapsing `[]` to `{}`, or reordering nested array values violates the brief. Escaping Unicode or reordering object keys without changing decoded values does not.

Initial recovery record: finalization `f71`, outcome `success`, the payload above, no phases. Every operation below must preserve the entire payload and all previously recorded phases.

| Order | Update                                                                                                        | Result                | Stored phases                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | `{"finalization_id":"f71","phase":"stored","value":{"at":0}}`                                                 | recorded              | `{"stored":{"at":0}}`                                                                                 |
| 2     | `{"finalization_id":"f71","phase":"delivered","value":{"at":37,"receipt":{"id":"r-first","empty":[]}}}`       | recorded              | `{"stored":{"at":0},"delivered":{"at":37,"receipt":{"id":"r-first","empty":[]}}}`                     |
| 3     | `{"finalization_id":"f71","phase":"stored","value":{"at":99}}`                                                | already_recorded_noop | `{"stored":{"at":0},"delivered":{"at":37,"receipt":{"id":"r-first","empty":[]}}}`                     |
| 4     | `{"finalization_id":"f71","phase":"delivered","value":{"at":48,"receipt":{"id":"r-replacement","empty":{}}}}` | already_recorded_noop | `{"stored":{"at":0},"delivered":{"at":37,"receipt":{"id":"r-first","empty":[]}}}`                     |
| 5     | `{"finalization_id":"stale-f70","phase":"cleanup","value":{"at":49}}`                                         | stale_identifier_noop | `{"stored":{"at":0},"delivered":{"at":37,"receipt":{"id":"r-first","empty":[]}}}`                     |
| 6     | `{"finalization_id":"f71","phase":"cleanup","value":{"at":52}}`                                               | recorded              | `{"stored":{"at":0},"delivered":{"at":37,"receipt":{"id":"r-first","empty":[]}},"cleanup":{"at":52}}` |

For independent phase updates, run all six orders of `stored(at=0)`, `delivered(at=37, receipt=r-first)`, and `cleanup(at=52)`. Every prefix must contain exactly the phases completed so far; every final value is their union. The JSON fixture has the full record after each operation. For same-phase contenders with different values, either can arrive first, but that first recorded value is permanent. In particular a second timestamp 99 must not replace timestamp zero, and the replacement receipt must not replace r-first.

Partial same-phase updates are underspecified: does recording only the timestamp freeze the whole phase, or may a previously absent receipt be added later? My preferred reading is first recording **per field**, but the fixture marks both interpretations for clarification rather than using this ambiguity to declare a defect:

| Initial phase    | Incoming                                   | Preferred per-field result | Alternative whole-phase result |
| ---------------- | ------------------------------------------ | -------------------------- | ------------------------------ |
| `{"at":0}`       | `{"at":12,"receipt":{}}`                   | `{"at":0,"receipt":{}}`    | `{"at":0}`                     |
| `{"receipt":[]}` | `{"at":21,"receipt":{"replacement":true}}` | `{"at":21,"receipt":[]}`   | `{"receipt":[]}`               |

The same first-recording rule should cover empty receipt objects or arrays if those are legal receipt values: emptiness is not absence. Phase updates under stale identifier f70 change neither phases nor payload of f71.

| Terminal order          | Winning job/journal outcome | Winning identifier |
| ----------------------- | --------------------------- | ------------------ |
| `["success","failure"]` | success                     | f-success          |
| `["failure","success"]` | failure                     | f-failure          |

A lost reply before the write has any effect leaves the record unchanged and no event published. A retry can do the work. A lost reply after a successful publication leaves one event published; retrying the same finalization must not publish a second. “Phase recorded” in these abstract publication fixtures denotes committed deduplication evidence associated with publication, not a prescribed storage field or a required transport acknowledgement. The broad brief promises at-most-once publication, not a particular marker schema or a globally atomic transaction across unrelated services.

### failure_before_publish_takes_effect

| Order | Operation                                         | Expected observation                                             |
| ----- | ------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | `{"op":"publish_once","fault":"before_write"}`    | `{"caller":"error","publications":0,"phase_recorded":false}`     |
| 2     | `{"op":"retry_same_finalization","fault":"none"}` | `{"caller":"success","publications":1,"phase_recorded":true}`    |
| 3     | `{"op":"retry_same_finalization","fault":"none"}` | `{"caller":"idempotent","publications":1,"phase_recorded":true}` |

### lost_reply_after_publish_takes_effect

| Order | Operation                                         | Expected observation                                             |
| ----- | ------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | `{"op":"publish_once","fault":"after_write"}`     | `{"caller":"error","publications":1,"phase_recorded":true}`      |
| 2     | `{"op":"retry_same_finalization","fault":"none"}` | `{"caller":"idempotent","publications":1,"phase_recorded":true}` |

### disconnected_subscriber

| Order | Operation                               | Expected observation                                                  |
| ----- | --------------------------------------- | --------------------------------------------------------------------- |
| 1     | `{"op":"publish_once","subscribers":0}` | `{"publications":1,"subscriber_receipt":false,"phase_recorded":true}` |
| 2     | `{"op":"connect_subscriber_and_retry"}` | `{"publications":1,"subscriber_receipt":false,"phase_recorded":true}` |

Also inject a reply loss around a phase update: before the write, the phase remains absent and retry records it; after the write, the first value remains and a retry with a later timestamp or different receipt cannot replace it. When journal creation fails before any write, a retry must retain the already chosen job winner if one exists. When journal creation commits but its reply is lost, a losing contender must not overwrite the winner on retry. The surviving coherent pair is always the same outcome/identifier, never a mixed pair.

Run these cases from both a legacy JSON string and native JSON-capable storage, comparing decoded semantic values. The brief does not require retaining the original wire serialization. A connected subscriber may receive the one event; a subscriber that connects afterwards is not promised a replay. A result of zero subscribers does not authorize republishing the same finalization.

## 4. Stream framing

First derive the logical records, then choose transport partitions. The fixed sequence below was authored before byte splits. Field values are raw text at the framing boundary; application JSON decoding occurs afterwards. The neutral event name is represented as an empty string. `authorization` is an illustrative concrete event name; map it to the protocol's declared authorization label without changing event-state expectations. `[DONE]` is the chosen concrete sentinel because the brief says DONE without spelling its wire token. That spelling is an explicit protocol assumption.

| Record | Event name        | Field             | Exact value                                       |
| ------ | ----------------- | ----------------- | ------------------------------------------------- |
| 1      | `"authorization"` | data              | `"{\"request_id\":\"a17\",\"label\":\"承認🙂\"}"` |
| 2      | `""`              | data              | `"{\"text\":\"Aé\"}"`                             |
| 3      | `""`              | data              | `"{\"text\":\"漢🙂z\"}"`                          |
| 4      | `""`              | intermediate_data | `"{\"step\":{\"nested\":[[],{}]}}"`               |
| 5      | `""`              | data              | `" {\"text\":\"one-leading-space\"}"`             |
| 6      | `""`              | data              | `"\t{\"text\":\"tab-preserved\"}"`                |
| 7      | `""`              | data              | `"{\"text\":\"colon:a:b\"}"`                      |

The authorization record is followed by a blank line, which resets the event before the ordinary content records. Two consecutive `data` lines remain two records. `Data` and `EVENT` have no special field meaning because names are case-sensitive. Exactly one optional ASCII space after the first colon is removed. Two spaces therefore preserve one; a tab is preserved. Colons after the first belong to the value.

The complete logical input lines, before terminator variation, are:

```text
event:authorization
data: {"request_id":"a17","label":"承認🙂"}

data:{"text":"Aé"}
data: {"text":"漢🙂z"}
intermediate_data: {"step":{"nested":[[],{}]}}
Data: ignored
EVENT: ignored
data:  {"text":"one-leading-space"}
data:	{"text":"tab-preserved"}
data: {"text":"colon:a:b"}
data: [DONE]
data: {"text":"must-not-appear"}
```

Each variant uses exactly this record sequence and sentinel. Four wire variants use only LF, only CRLF, only CR, and a repeating mixed terminator pattern `[CRLF,CR,LF,CRLF,LF]`. Every variant is delivered whole, one byte per chunk with empty chunks between bytes, and at every possible two-chunk split with an empty chunk inserted between the two parts. This includes every byte inside `é`, `漢`, and `🙂`, and every CR/LF split.

CRLF is one terminator even when delivered as CR, empty chunk, LF. An empty chunk is not EOF and must not clear pending decoder or CR state. CR immediately followed by CRLF is two terminators, so it creates a blank line. No replacement character, lost scalar, extra blank line, or changed event assignment may depend on partitioning. Processing stops at the sentinel; the trailing `must-not-appear` record is never emitted.

| Variant | Bytes | Partitions |
| ------- | ----- | ---------- |
| lf      | 331   | 332        |
| crlf    | 344   | 345        |
| cr      | 331   | 332        |
| mixed   | 336   | 337        |

two_records_not_multiline_concatenation: input `"data: first\ndata: second\n\n"`; expected `[{"event":"","field":"data","value":"first"},{"event":"","field":"data","value":"second"}]`.

event_survives_without_blank: input `"event: authorization\ndata: first\ndata: second\n"`; expected `[{"event":"authorization","field":"data","value":"first"},{"event":"authorization","field":"data","value":"second"}]`.

cr_crlf_is_two_terminators: input `"event: authorization\rdata: first\r\r\ndata: second\r"`; expected `[{"event":"authorization","field":"data","value":"first"},{"event":"","field":"data","value":"second"}]`.

event_with_two_spaces_preserves_one: input `"event:  authorization\ndata: first\n\ndata: second\n"`; expected `[{"event":" authorization","field":"data","value":"first"},{"event":"","field":"data","value":"second"}]`.

case_sensitive_intermediate: input `"Intermediate_data: ignored\nintermediate_data: kept\n"`; expected `[{"event":"","field":"intermediate_data","value":"kept"}]`.

Unterminated EOF lines, bare fields without a colon, BOM handling, malformed UTF-8, blank data values, and an escaped or padded sentinel were not fully specified. These fixtures deliberately avoid choosing a failure policy for them. They also do not import EventSource multiline data concatenation, which the brief explicitly excludes.

## 5. Stream persistence

The reference treats declared segments and steps as sequences. Given current sequence X of length N and a batch B declared to begin at P:

1. P>N is a gap: reject the entire batch and leave X unchanged.
2. Compare every existing overlapped position: for i from 0 through min(N−P,len(B))−1, X[P+i] must equal B[i]. Any conflict rejects the entire batch, including any otherwise new suffix.
3. When overlap agrees, retain X and append only B[min(N−P,len(B)):]. A retry entirely inside the stored prefix changes nothing and never truncates later progress.

The response corpus is `S=["Aé","漢🙂z","e\u0301","Aé","!"]`. S0 and S3 are deliberately identical at different positions. They must both remain. The combining sequence e + U+0301 is two Unicode scalars and must not be normalized to U+00E9 without an explicit normalization contract. The joined final response is `Aé漢🙂zéAé!`.

The brief does not declare the append API's position unit. Segment ordinal is the canonical model; scalar and UTF-8 byte projections are supplied for APIs using text offsets. A comparison adapter must establish its API's coordinate contract explicitly. It may not compare a segment ordinal to a byte end merely because ASCII examples happened to agree.

| Prefix segments | Unicode scalar end | UTF-16 code-unit end | UTF-8 byte end |
| --------------- | ------------------ | -------------------- | -------------- |
| 0               | 0                  | 0                    | 0              |
| 1               | 2                  | 2                    | 3              |
| 2               | 5                  | 6                    | 11             |
| 3               | 7                  | 8                    | 14             |
| 4               | 9                  | 10                   | 17             |
| 5               | 10                 | 11                   | 18             |

The final response has five segments, ten Unicode scalars, eleven UTF-16 code units, and eighteen UTF-8 bytes. In a byte-offset API, positions must refer to encoded boundaries; slicing inside a multibyte scalar cannot produce a valid text segment. In a scalar-offset API, immediately before/at/after end 10 means 9/10/11; in a byte API it means 17/18/19. The projected fixture uses valid segment boundaries for actual batches. Empty segments need separate sequence accounting because an empty segment advances segment ordinal but not text length.

The following is the complete ordered response scenario. Every row executes against the previous row's stored state. “After write” reports an error to the caller even though the storage mutation took effect. “Before write” reports an error and changes nothing. Retry batches deliberately grow after a lost reply.

| Order | P   | Batch                   | Fault        | Caller result      | Stored segments               | Stored text     |
| ----- | --- | ----------------------- | ------------ | ------------------ | ----------------------------- | --------------- |
| 1     | 0   | `["Aé"]`                | none         | appended           | `["Aé"]`                      | `"Aé"`          |
| 2     | 1   | `["漢🙂z","é"]`         | before_write | error_before_write | `["Aé"]`                      | `"Aé"`          |
| 3     | 0   | `["Aé","漢🙂z"]`        | after_write  | error_after_write  | `["Aé","漢🙂z"]`              | `"Aé漢🙂z"`     |
| 4     | 0   | `["Aé","漢🙂z","é"]`    | none         | appended           | `["Aé","漢🙂z","é"]`          | `"Aé漢🙂zé"`    |
| 5     | 1   | `["漢🙂z"]`             | none         | idempotent         | `["Aé","漢🙂z","é"]`          | `"Aé漢🙂zé"`    |
| 6     | 2   | `["é","Aé"]`            | none         | appended           | `["Aé","漢🙂z","é","Aé"]`     | `"Aé漢🙂zéAé"`  |
| 7     | 3   | `["Aé"]`                | none         | idempotent         | `["Aé","漢🙂z","é","Aé"]`     | `"Aé漢🙂zéAé"`  |
| 8     | 4   | `["!"]`                 | none         | appended           | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |
| 9     | 6   | `["WRONG"]`             | none         | reject_gap         | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |
| 10    | 4   | `["WRONG"]`             | none         | reject_conflict    | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |
| 11    | 3   | `["WRONG","!","WRONG"]` | none         | reject_conflict    | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |
| 12    | 0   | `["Aé"]`                | none         | idempotent         | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |
| 13    | 5   | `[]`                    | none         | idempotent         | `["Aé","漢🙂z","é","Aé","!"]` | `"Aé漢🙂zéAé!"` |

Rows 6 and 7 address a position immediately before the current end, row 8 addresses the end, and row 9 addresses immediately after the end. Row 11 contains conflicting overlap plus a new suffix and must append none of it. The old retry in row 12 cannot replace or truncate the newer response. Row 13 is an empty batch exactly at the end and changes nothing.

The step sequence contains unequal objects, repeated identical objects at positions zero and three, nested empty arrays, an empty object, and the two distinct large integers:

Q0 = `{"kind":"plan","payload":[]}`.

Q1 = `{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}`.

Q2 = `{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}`.

Q3 = `{"kind":"plan","payload":[]}`.

Q4 = `{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}`.

| Order | P   | Batch                                                                                                                                                            | Fault        | Caller result      | Full stored steps                                                                                                                                                                                                                                               |
| ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 0   | `[{"kind":"plan","payload":[]}]`                                                                                                                                 | none         | appended           | `[{"kind":"plan","payload":[]}]`                                                                                                                                                                                                                                |
| 2     | 1   | `[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                              | before_write | error_before_write | `[{"kind":"plan","payload":[]}]`                                                                                                                                                                                                                                |
| 3     | 0   | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                 | after_write  | error_after_write  | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                                                                                                                |
| 4     | 0   | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]` | none         | appended           | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 5     | 1   | `[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                                              | none         | idempotent         | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 6     | 2   | `[{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]}]`                                                                 | none         | appended           | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]}]`                                                                   |
| 7     | 3   | `[{"kind":"plan","payload":[]}]`                                                                                                                                 | none         | idempotent         | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]}]`                                                                   |
| 8     | 4   | `[{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]`                                                                                            | none         | appended           | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |
| 9     | 6   | `[{"kind":"conflict"}]`                                                                                                                                          | none         | reject_gap         | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |
| 10    | 4   | `[{"kind":"conflict"}]`                                                                                                                                          | none         | reject_conflict    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |
| 11    | 3   | `[{"kind":"conflict"},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}},{"kind":"conflict"}]`                                                    | none         | reject_conflict    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |
| 12    | 0   | `[{"kind":"plan","payload":[]}]`                                                                                                                                 | none         | idempotent         | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |
| 13    | 5   | `[]`                                                                                                                                                             | none         | idempotent         | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |

The step positions count JSON objects, not JSON string length or bytes. Semantic comparison accepts reordered object keys but rejects array order changes, numeric value changes, or replacing [] with {}. The `json_object_order` fixture probes both. The `empty_response_segment` fixture ends with segments `["","é"]` and text `é`; the older retry of the empty first segment must not discard é.

Two writes flushed together need independent acknowledgement/progress accounting. The contract explicitly permits one write to fail while the other succeeds, so I do not assume pairwise transactionality. Partial intermediate storage is permitted; retry must converge both sequences exactly. The following four schedules exercise both asymmetric failure directions and both asymmetric acknowledgement directions:

### response_commits_steps_do_not

| Order | Response write                                                                                                        | Step write                                                                                                                                                                                                                                            | Stored response | Stored steps                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"start":0,"items":["Aé","漢🙂z"],"fault":"after_write","result":"error_after_write","committed_result":"appended"}` | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"before_write","result":"error_before_write","committed_result":null}`                                                     | `"Aé漢🙂z"`     | `[]`                                                                                                                                                                                                                                                            |
| 2     | `{"start":0,"items":["Aé","漢🙂z","é"],"fault":"none","result":"appended","committed_result":"appended"}`             | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}],"fault":"none","result":"appended","committed_result":"appended"}` | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 3     | `{"start":1,"items":["漢🙂z"],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                  | `{"start":1,"items":[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                                                                                          | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 4     | `{"start":3,"items":["Aé","!"],"fault":"none","result":"appended","committed_result":"appended"}`                     | `{"start":3,"items":[{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}],"fault":"none","result":"appended","committed_result":"appended"}`                                                               | `"Aé漢🙂zéAé!"` | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |

### steps_commit_response_does_not

| Order | Response write                                                                                                    | Step write                                                                                                                                                                                                                                            | Stored response | Stored steps                                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"start":0,"items":["Aé","漢🙂z"],"fault":"before_write","result":"error_before_write","committed_result":null}` | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"after_write","result":"error_after_write","committed_result":"appended"}`                                                 | `""`            | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                                                                                                                |
| 2     | `{"start":0,"items":["Aé","漢🙂z","é"],"fault":"none","result":"appended","committed_result":"appended"}`         | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}],"fault":"none","result":"appended","committed_result":"appended"}` | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 3     | `{"start":1,"items":["漢🙂z"],"fault":"none","result":"idempotent","committed_result":"idempotent"}`              | `{"start":1,"items":[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                                                                                          | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 4     | `{"start":3,"items":["Aé","!"],"fault":"none","result":"appended","committed_result":"appended"}`                 | `{"start":3,"items":[{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}],"fault":"none","result":"appended","committed_result":"appended"}`                                                               | `"Aé漢🙂zéAé!"` | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |

### response_acknowledged_steps_unknown

| Order | Response write                                                                                            | Step write                                                                                                                                                                                                                                            | Stored response | Stored steps                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"start":0,"items":["Aé","漢🙂z"],"fault":"none","result":"appended","committed_result":"appended"}`     | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"after_write","result":"error_after_write","committed_result":"appended"}`                                                 | `"Aé漢🙂z"`     | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                                                                                                                |
| 2     | `{"start":0,"items":["Aé","漢🙂z","é"],"fault":"none","result":"appended","committed_result":"appended"}` | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}],"fault":"none","result":"appended","committed_result":"appended"}` | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 3     | `{"start":1,"items":["漢🙂z"],"fault":"none","result":"idempotent","committed_result":"idempotent"}`      | `{"start":1,"items":[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                                                                                          | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 4     | `{"start":3,"items":["Aé","!"],"fault":"none","result":"appended","committed_result":"appended"}`         | `{"start":3,"items":[{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}],"fault":"none","result":"appended","committed_result":"appended"}`                                                               | `"Aé漢🙂zéAé!"` | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |

### steps_acknowledged_response_unknown

| Order | Response write                                                                                                        | Step write                                                                                                                                                                                                                                            | Stored response | Stored steps                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `{"start":0,"items":["Aé","漢🙂z"],"fault":"after_write","result":"error_after_write","committed_result":"appended"}` | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"none","result":"appended","committed_result":"appended"}`                                                                 | `"Aé漢🙂z"`     | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}]`                                                                                                                                                                |
| 2     | `{"start":0,"items":["Aé","漢🙂z","é"],"fault":"none","result":"appended","committed_result":"appended"}`             | `{"start":0,"items":[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}],"fault":"none","result":"appended","committed_result":"appended"}` | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 3     | `{"start":1,"items":["漢🙂z"],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                  | `{"start":1,"items":[{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}}],"fault":"none","result":"idempotent","committed_result":"idempotent"}`                                                                                          | `"Aé漢🙂zé"`    | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}}]`                                                                                                |
| 4     | `{"start":3,"items":["Aé","!"],"fault":"none","result":"appended","committed_result":"appended"}`                     | `{"start":3,"items":[{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}],"fault":"none","result":"appended","committed_result":"appended"}`                                                               | `"Aé漢🙂zéAé!"` | `[{"kind":"plan","payload":[]},{"kind":"tool","payload":{"rows":[[],{}],"n":9007199254740990}},{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740991}},{"kind":"plan","payload":[]},{"kind":"final","payload":{"empty":{},"nested":[[[]]],"ok":true}}]` |

Twelve additional structured schedules use independent seed **147083**, alternating response and step cases. Each has 32 generated progress/retry/overlap/gap/conflict attempts with independently sampled before-write or after-write reply losses, followed by one valid full-prefix retry. The fixture contains the complete input and expected state after all 396 operations. Each final state must equal the declared five-element corpus. They are additional discriminators, not evidence that the application has passed anything.

Two concurrent identical batches are idempotent regardless of ordering. A later-position batch that linearizes before its prerequisite is persisted must reject as a gap; retry after the prerequisite commits may succeed. Concurrent conflicting contenders for the same previously empty position may have either first winner, but the second must reject rather than replace it. No list of observed results can justify accepting a schedule that has no serial order satisfying these rules.

## 6. Outbound resource addresses

Classification below is derived from prefix arithmetic and the explicitly excluded classes. IPv4 is the integer a·2^24+b·2^16+c·2^8+d. A /10 shared range has 2^22 addresses, beginning at 100.64.0.0, so its inclusive end is 100.127.255.255. Equivalently, the first octet is 100 and 64≤the second octet≤127. This allocation is defined in [RFC 6598](https://www.rfc-editor.org/info/rfc6598/).

For IPv6 site-local /10, the first ten bits are 1111111011. The first hextet therefore ranges from fec0 to feff inclusive, with every remaining 112-bit suffix. The immediately preceding integer is febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff; it is outside site-local but inside link-local fe80::/10. The next integer after the site-local maximum is ff00::, which is multicast. All three regions are forbidden under the brief. Deprecation of site-local does not turn it into an allowed application target. See [RFC 3879, section 4](https://www.rfc-editor.org/rfc/rfc3879.html#section-4) and the link-local/multicast prefixes in [RFC 4291, section 2.4](https://www.rfc-editor.org/rfc/rfc4291.html#section-2.4).

“Public unicast” is taken as a permitted address class, not proof of global route availability or a single physical destination. IPv6 anycast uses unicast address syntax and is not distinguishable from unicast solely by parsing the address, as [RFC 4291, section 2.6](https://www.rfc-editor.org/rfc/rfc4291.html#section-2.6) explains. A literal ban on all deployed anycast services cannot be implemented from DNS address syntax alone and needs clarification. These fixtures allow ordinary global-unicast address forms, even when a service might deploy them as anycast.

| Address                                     | Allowed | Reason                                      |
| ------------------------------------------- | ------- | ------------------------------------------- |
| `"100.63.255.254"`                          | True    | public_unicast_outside_shared               |
| `"100.63.255.255"`                          | True    | immediately_below_shared                    |
| `"100.64.0.0"`                              | False   | first_shared                                |
| `"100.64.0.1"`                              | False   | shared                                      |
| `"100.127.255.254"`                         | False   | shared                                      |
| `"100.127.255.255"`                         | False   | last_shared                                 |
| `"100.128.0.0"`                             | True    | immediately_above_shared                    |
| `"100.128.0.1"`                             | True    | public_unicast_outside_shared               |
| `"febf:ffff:ffff:ffff:ffff:ffff:ffff:fffe"` | False   | link_local                                  |
| `"febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"` | False   | immediately_below_site_local_but_link_local |
| `"fec0::"`                                  | False   | first_site_local                            |
| `"fec0::1"`                                 | False   | site_local                                  |
| `"fed7:89ab::19"`                           | False   | site_local                                  |
| `"feff:ffff:ffff:ffff:ffff:ffff:ffff:fffe"` | False   | site_local                                  |
| `"feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"` | False   | last_site_local                             |
| `"ff00::"`                                  | False   | immediately_above_site_local_but_multicast  |
| `"ff00::1"`                                 | False   | multicast                                   |
| `"93.184.216.34"`                           | True    | ordinary_public_unicast_address_form        |
| `"2606:4700:4700::1111"`                    | True    | global_unicast_address_form                 |
| `"0.0.0.0"`                                 | False   | unspecified                                 |
| `"0.7.8.9"`                                 | False   | this_network                                |
| `"10.0.0.1"`                                | False   | private                                     |
| `"127.0.0.1"`                               | False   | loopback                                    |
| `"169.254.9.3"`                             | False   | link_local                                  |
| `"172.16.0.0"`                              | False   | private                                     |
| `"172.31.255.255"`                          | False   | private                                     |
| `"192.168.0.1"`                             | False   | private                                     |
| `"192.0.2.7"`                               | False   | documentation                               |
| `"198.18.0.1"`                              | False   | benchmarking                                |
| `"224.0.0.0"`                               | False   | multicast                                   |
| `"239.255.255.255"`                         | False   | multicast                                   |
| `"240.0.0.0"`                               | False   | reserved                                    |
| `"255.255.255.255"`                         | False   | limited_broadcast                           |
| `"::"`                                      | False   | unspecified                                 |
| `"::1"`                                     | False   | loopback                                    |
| `"fe80::1"`                                 | False   | link_local                                  |
| `"fc00::1"`                                 | False   | unique_local                                |
| `"fdff:ffff::1"`                            | False   | unique_local                                |
| `"2001:db8::1"`                             | False   | documentation                               |
| `"::ffff:127.0.0.1"`                        | False   | mapped_loopback                             |
| `"::ffff:100.64.0.1"`                       | False   | mapped_shared                               |

The additional exclusions for documentation, benchmarking, unique-local, and other special-use examples follow the primary [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry) and [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry). Global reachability classification is not itself a promise that a host will answer. Mapped IPv4 loopback or shared addresses remain prohibited; wrapping an excluded IPv4 destination in IPv6 notation cannot make the eventual endpoint public. I did not choose a blanket rule for every translation/transition prefix or every more-specific public exception inside a special registry block.

Answer acceptance is universal, not existential: a nonempty DNS answer is allowed iff every address is allowed. Address order cannot change the decision. An empty answer supplies no validated target and cannot authorize a connection.

| DNS answer                                 | Allowed | Connections when rejected |
| ------------------------------------------ | ------- | ------------------------- |
| `["100.63.255.255","100.128.0.1"]`         | True    | None                      |
| `["100.64.0.0"]`                           | False   | 0                         |
| `["100.63.255.255","100.64.0.0"]`          | False   | 0                         |
| `["100.64.0.0","100.63.255.255"]`          | False   | 0                         |
| `["93.184.216.34","2606:4700:4700::1111"]` | True    | None                      |
| `["fec0::1"]`                              | False   | 0                         |
| `["2606:4700:4700::1111","fec0::1"]`       | False   | 0                         |
| `["fec0::1","2606:4700:4700::1111"]`       | False   | 0                         |
| `[]`                                       | False   | 0                         |

| Connection scenario      | Inputs                                                                                                 | Expected                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| pinned_answer            | `{"validated":["93.184.216.34","100.128.0.1"],"connection_peer":"100.128.0.1"}`                        | allowed                        |
| public_but_not_validated | `{"validated":["93.184.216.34"],"connection_peer":"100.128.0.1"}`                                      | reject                         |
| rebind_private           | `{"validated":["93.184.216.34"],"later_dns":["127.0.0.1"],"connection_peer":"127.0.0.1"}`              | reject_before_connect          |
| redirect_to_private      | `{"initial_answer":["93.184.216.34"],"redirect_answer":["100.64.0.1"]}`                                | reject_redirect_before_connect |
| redirect_mixed           | `{"initial_answer":["93.184.216.34"],"redirect_answer":["93.184.216.34","fec0::1"]}`                   | reject_redirect_before_connect |
| redirect_public          | `{"initial_answer":["93.184.216.34"],"redirect_answer":["100.128.0.1"],"redirect_peer":"100.128.0.1"}` | allowed                        |

Membership means numerical address membership, so harmless IPv6 compression or case changes do not create a new destination. A connection to an allowed address outside the validated answer is still a violation. Redirect validation must precede connecting to the redirected address and must apply the same universal-answer rule. HTTP and HTTPS are permitted schemes; file, FTP, and gopher are outside this fetch contract. The fixtures are classification inputs; no live requests to these numeric addresses were made.

## 7. Redis command errors

Input here is a decoded Redis error message. The raw RESP `-` prefix and terminating CRLF have already been removed. The topology code must be the first exact uppercase token: READONLY or MASTERDOWN, ending at the first ASCII space or end of message. The convention is supported by the [Redis protocol specification, simple errors](https://redis.io/docs/latest/develop/reference/protocol-spec/#simple-errors), which identifies the leading error prefix rather than searching arbitrary words inside a message. A tab or colon is not the specified ASCII-space delimiter. Leading whitespace, lowercase names, and a client-added exception wrapper are not silently normalized by this reference; an adapter with a separately exposed error-code property should use that property.

The brief reserves reconnection for the two topology errors. These rows mean reconnect eligibility; they do not prescribe a new connection per duplicate observation or bypass an existing reconnect in progress. Reconnection must not replay the failed consequential command automatically.

| Decoded message                                                                    | Reconnect eligible | Auto replay |
| ---------------------------------------------------------------------------------- | ------------------ | ----------- |
| `"READONLY"`                                                                       | True               | False       |
| `"READONLY You cannot write against a read only replica."`                         | True               | False       |
| `"MASTERDOWN"`                                                                     | True               | False       |
| `"MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to no."` | True               | False       |
| `"READONLY "`                                                                      | True               | False       |
| `"MASTERDOWN  unavailable"`                                                        | True               | False       |
| `"WRONGTYPE Operation against a key holding the wrong kind of value"`              | False              | False       |
| `"ERR wrong Redis type"`                                                           | False              | False       |
| `"NOPERM this user has no permissions to run JSON.GET"`                            | False              | False       |
| `"NOAUTH Authentication required."`                                                | False              | False       |
| `"ERR syntax error"`                                                               | False              | False       |
| `"ERR unknown command JSON.GET"`                                                   | False              | False       |
| `"ERR READONLY during application validation"`                                     | False              | False       |
| `"WRONGTYPE MASTERDOWN is a payload word"`                                         | False              | False       |
| `"READONLYISH replica"`                                                            | False              | False       |
| `"MASTERDOWNSTREAM failure"`                                                       | False              | False       |
| `"XREADONLY"`                                                                      | False              | False       |
| `"READONLY: detail"`                                                               | False              | False       |
| `"READONLY\tdetail"`                                                               | False              | False       |
| `" READONLY detail"`                                                               | False              | False       |
| `"readonly detail"`                                                                | False              | False       |
| `""`                                                                               | False              | False       |

### legacy_type_fallback

Ordered commands/responses: `[{"command":"JSON.GET","response":"WRONGTYPE Operation against a key holding the wrong kind of value"},{"command":"GET","response":"{\"kept\":[],\"n\":9007199254740991}"}]`.

Expected: `{"value":{"kept":[],"n":9007199254740991},"json_get_count":1,"get_count":1,"reconnect_count":0,"client_generation_change":false}`.

### topology_error

Ordered commands/responses: `[{"command":"possibly_consequential_command","response":"READONLY replica"}]`.

Expected: `{"original_command_count":1,"automatically_replayed":false,"topology_reconnect_eligible":true,"caller_observes_error":true}`.

### permission_error

Ordered commands/responses: `[{"command":"JSON.GET","response":"NOPERM forbidden"}]`.

Expected: `{"reconnect_count":0,"fallback_get_count":0,"caller_observes_error":true}`.

### both_reads_wrongtype

Ordered commands/responses: `[{"command":"JSON.GET","response":"WRONGTYPE wrong type"},{"command":"GET","response":"WRONGTYPE wrong type"}]`.

Expected: `{"json_get_count":1,"get_count":1,"reconnect_count":0,"caller_observes_error":true}`.

A correct legacy fallback shows exactly one JSON-specific read, its type error, then one string GET on the same usable connection, returning the decoded legacy value. Client generation and reconnect count do not change. Repeated JSON.GET attempts, repeated client replacement, absence of GET, or eventual timeout after swallowed type errors distinguish a reconnect loop. If GET itself has a type error, propagate that command error without looping.

A permission error is not evidence of legacy storage and does not justify bypassing the denied JSON command through GET. The brief does not explicitly authorize fallback on unknown-command errors; that is a separate compatibility policy. In either case, neither is a topology reconnection trigger. For a topology error, observe one original command attempt, one propagated failure, and eligible connection recovery for later work; an automatic second attempt of a potentially consequential command violates the no-replay constraint.

## Artifact scope and reproducibility

The original JSON fixture is `/tmp/daedalus-independent-fixtures-20260909.json`. Its independently authored generator is `/tmp/daedalus-independent-reference-20260909.py`; this Markdown renderer is `/tmp/daedalus-independent-render-20260909.py`. The generator imports only Python standard-library modules and reads no application files. The renderer reads only that generated fixture. The fixture includes full expected stored values at every sequence/job/phase operation, byte-exact stream inputs, and all stated assumptions.

This is an oracle derivation, not an application test result. The coordinating auditor must map semantic fields to actual APIs and report mismatches, keeping representation adaptations separate from changed expectations. Any disputed assumption must be resolved openly from the contract; a mismatch is not permission to mutate this original reference to match the implementation.

Fixture SHA-256: `854e10f07cc7904c2d38ca113166408e6fbe59fc120e4947f8bf86b35ea16865`.
