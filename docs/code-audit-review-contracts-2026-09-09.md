# Independent behavior review brief

This brief defines application contracts for an independent reviewer. It does
not describe the implementation or supply expected outputs for the examples.
The review has not run yet.

## Review procedure

Start with a fresh conversation context containing only this brief. Do not read
the application source, existing tests, audit report, or earlier conversation.
Do not import application helpers into a reference calculation.

For each contract below, derive an explicit table of inputs, operation order,
expected return values, and final stored data. Explain any ambiguity before
choosing a result. Include boundary cases on both sides of each relevant limit
and distinguish competing interpretations. Where useful, produce standalone
JSON fixtures or a small reference model with structured randomized schedules.
Choose seeds and examples independently.

The coordinating auditor will compare those results against the application in
a disposable environment. The reviewer should retain the original derivation
so a mismatch cannot be resolved by silently changing the reference to match
the application. Report conclusions and any generated fixture paths without
editing application files.

## Authentication lifetime

An authenticated session lasts 24 hours after its most recent activity refresh.
Refresh is throttled: it is due only when activity is more than 60,000 ms older
than the request time. Logout deletes the session. Activity refresh must not
create a session, extend a session that has expired, or move its activity time
backwards. An already authorized request may finish after logout.

Derive results for activity ages 59,999, 60,000, and 60,001 ms; logout or expiry
between observing a session and attempting its refresh; and a second request
refreshing the session while the first request still holds an older observation.
Distinguish the return value of the current request from future authentication.

## Job outcomes and authorization prompts

A job starts live. Either success or failure can terminate it; only the first
terminal transition may take effect. A stored success/failure status is terminal
even without a finalization timestamp. A present finalization timestamp is also
terminal, including timestamp zero. Missing jobs must not be recreated by an
update. Terminal data includes metadata and pending authorization prompts.

A job may have several pending authorization requests. Completing one matching
request removes only that request and exposes any remaining prompt. Unknown or
repeated callbacks have no effect. Once the job is terminal, callbacks and other
live updates have no effect.

Derive results for overlapping live/terminal updates, simultaneous terminal
contenders, metadata-only changes, missing records, and two callbacks completing
different requests concurrently. Include a live update whose observation
predates a terminal transition but whose write happens later.

## Finalization records

The winning job outcome and its recovery record represent the same decision.
Finalization phases can complete independently. Recording one phase preserves
all other phases and payload data; the first recorded timestamp or receipt for
that phase is retained. A phase update bearing another finalization identifier
has no effect. Completion events for one finalization are published at most
once even when the caller loses the reply to a successful publication attempt.
This does not promise delivery to a disconnected subscriber.

Derive examples with empty arrays, empty objects, nested arrays, and the distinct
integers 9,007,199,254,740,990 and 9,007,199,254,740,991. Include concurrent phase
updates, zero-valued timestamps, replacement receipts, stale identifiers, and
lost replies both before and after a write takes effect. Representation changes
between ordinary JSON strings and JSON-capable storage must not change meaning.

## Stream framing

The backend emits UTF-8 text with line-oriented `event`, `data`, and
`intermediate_data` fields. Each data line is its own record. LF, CRLF, and CR
terminate lines. A blank line resets the event name. The first colon separates
the field name from its value, with one optional following space. Field names
are case-sensitive. A transport chunk may split any UTF-8 character or line
terminator; empty chunks are permitted. A DONE record terminates processing.

Derive streams where an authorization event is followed by a blank line and an
ordinary content record. Vary terminators, colon spacing, and transport splits,
including an empty chunk between the CR and LF. The expected record sequence
must be derived before choosing transport partitions. Multiline EventSource
data concatenation is outside this application's contract.

## Stream persistence

The logical response is an ordered sequence of Unicode text segments, and the
logical step history is an ordered sequence of JSON objects. Flush batches may
overlap already persisted data after a lost reply, and a retry may include new
data accumulated since the failed attempt. A retry of an older batch may also
arrive after later progress. Persistence must retain exactly the declared
sequence without duplication, truncation, or replacement of conflicting data.
Gaps and conflicting overlap are rejected without altering stored data.

Derive a reference independently for response positions and step positions.
Use unequal segment sizes, non-ASCII text, repeated identical segments at
different positions, nested empty arrays, older retries, overlap with a new
suffix, and positions immediately before/at/after the current end. Distinguish
text character counts from encoded byte counts where relevant. Include failures
before a write, after a write but before acknowledgement, and in only one of two
independent writes that are being flushed together.

## Outbound resource addresses

Tools may fetch public HTTP(S) resources. Every address in a DNS answer must be
an allowed public unicast address, and the address used by the connection must
come from that validated answer. Local, private, link-local, shared carrier NAT,
deprecated IPv6 site-local, multicast, reserved, and unspecified targets are
excluded. Redirects are subject to the same rule.

Derive boundary examples around the shared IPv4 range 100.64.0.0/10 and IPv6
site-local range fec0::/10. Include answers containing only permitted addresses,
a single excluded address, and mixed answers in both orders. Use numeric range
reasoning for expected classifications rather than the application's address
helper. State any external classification assumptions that need a primary
standards reference.

## Redis command errors

Some reads first try a JSON-specific command and fall back to an ordinary string
read when the key uses legacy storage. Such a type error does not imply a failed
connection. Reconnection is reserved for READONLY and MASTERDOWN topology
errors; it must not automatically replay a possibly consequential command.

Derive classifications for exact topology-error names with and without a
following explanation, ordinary type/permission/syntax errors, and strings that
merely contain a topology-error word inside another error. Explain which
observations distinguish a correct fallback from a reconnect loop.
