# Independent derivation amendment — 2026-09-09

This is a separate clarification of the original independent derivation at `/tmp/daedalus-independent-review-20260909.md`. The original derivation, fixtures, and checksum manifest remain unchanged. This amendment uses only the original review brief and mathematical reasoning; no application source or tests were inspected.

## Step objects and positions

Positions below are zero-based step ordinals. Objects are compared as JSON values: property order is immaterial, array element order is material, and an empty array differs from an empty object. The brief requires preservation of the declared sequence and rejection of conflicting overlap without any write. It does not require preserving insignificant serialization whitespace or property order.

Use these exact objects:

```json
{
  "A": { "kind": "plan", "payload": [] },
  "B": {
    "kind": "tool",
    "payload": { "rows": [[], {}], "n": 9007199254740990 }
  },
  "C": {
    "kind": "final",
    "payload": { "empty": {}, "nested": [[[]]], "n": 9007199254740991 }
  },
  "X": {
    "kind": "tool",
    "payload": { "rows": [[], {}], "n": 9007199254740991 }
  }
}
```

Here B and X differ only in a numerically significant field. Their distinct integers must not collapse during any comparison or serialization.

## 1. Reserialized older overlap with a new suffix

Execute these operations in order:

1. Store `[A,B]` at positions zero and one.
2. A caller submits a batch starting at position one. Its first object is B reserialized with the property order reversed at both object levels, and its second object is the new suffix C:

   ```json
   [
     { "payload": { "n": 9007199254740990, "rows": [[], {}] }, "kind": "tool" },
     {
       "kind": "final",
       "payload": { "empty": {}, "nested": [[[]]], "n": 9007199254740991 }
     }
   ]
   ```

3. Compare the first incoming object semantically with stored B. They agree, so retain the existing prefix and append only C.

Expected semantic return: accepted, one step appended. The final end position is three. Exact final data, with one representative object property order, is:

```json
[
  { "kind": "plan", "payload": [] },
  { "kind": "tool", "payload": { "rows": [[], {}], "n": 9007199254740990 } },
  {
    "kind": "final",
    "payload": { "empty": {}, "nested": [[[]]], "n": 9007199254740991 }
  }
]
```

Retrying that same two-object batch at position one after this success is accepted as an idempotent no-op; the final data remains exactly the same. Raw JSON string inequality is insufficient grounds for rejecting either attempt.

## 2. Material JSON differences in overlap

Each subcase starts independently from `[A,B]`. Each attempts a two-object batch at position one, with the modified object followed by C. The proposed C must not be appended when the overlapping object conflicts.

| Subcase                                  | First incoming object                                             | Expected result                                |
| ---------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| 2a: array order changed                  | `{"kind":"tool","payload":{"rows":[{},[]],"n":9007199254740990}}` | Reject the whole batch as conflicting overlap. |
| 2b: empty array replaced by empty object | `{"kind":"tool","payload":{"rows":[{},{}],"n":9007199254740990}}` | Reject the whole batch as conflicting overlap. |

The stored end remains two after either subcase. Exact final data in both cases is:

```json
[
  { "kind": "plan", "payload": [] },
  { "kind": "tool", "payload": { "rows": [[], {}], "n": 9007199254740990 } }
]
```

These differ from case 1 because they change JSON meaning. Sorting object keys for comparison is compatible with case 1; sorting array elements or converting empty containers to one common representation would invalidate case 2.

## 3. Storage changes between inspection and append

### 3a. A conflict created entirely by valid concurrent appends

This schedule needs no overwriting of previously stored positions:

| Order | Operation                                                                | Expected stored data and result                                                                                            |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1     | Initial storage contains A only.                                         | `[A]`, end one.                                                                                                            |
| 2     | Caller P inspects `[A]` and prepares a batch `[A,B,C]` starting at zero. | Read only; storage remains `[A]`. The observed overlap A agrees.                                                           |
| 3     | Caller Q appends `[X]` at position one and its write takes effect.       | Accepted; storage becomes `[A,X]`, end two.                                                                                |
| 4     | Caller P's prepared append takes effect after Q.                         | Current overlap is now `[A,X]`, compared with incoming `[A,B]`. X differs from B. Reject P's entire batch; append nothing. |

Exact final data is:

```json
[
  { "kind": "plan", "payload": [] },
  { "kind": "tool", "payload": { "rows": [[], {}], "n": 9007199254740991 } }
]
```

P's previously successful inspection cannot authorize a later append against a different current overlap. `[A,X,C]`, `[A,X,B,C]`, and `[A,B,C]` are all incorrect outcomes for this ordering. In the reverse effective-write order, P may win and store `[A,B,C]`, after which Q must reject because B differs from X. A simultaneous invocation does not prescribe the winner, but the effective order does prescribe the result.

### 3b. An already inspected overlapping position is replaced by an external actor

This is an explicit state-change injection, not a claim that a conforming append operation can replace existing data:

1. Initial storage is `[A,B]`.
2. P inspects B at position one, then prepares `[B,C]` starting at one. Its incoming B may use the alternate property order from case 1.
3. A separate actor replaces stored B with X, leaving storage `[A,X]`, before P's append takes effect.
4. P must detect the current B-versus-X conflict and reject the entire batch. Final data is exactly the `[A,X]` JSON shown in case 3a, with end two and no C.

The replacement in step 3 is itself outside the permitted append-only behavior; it can model another storage writer or an injected interleaving. The append operation must still avoid replacing conflicting data or appending a suffix after stale validation. If the system guarantees that no other operation can ever mutate existing positions, case 3a is the fully internal, contract-conforming way to test the same need to validate against current storage.

## Clarification: the session lifetime anchor

The brief says an authenticated session lasts 24 hours after its most recent activity refresh. It separately specifies refresh eligibility using activity age relative to the **request time**. It does not explicitly define whether the refreshed lifetime begins at the request timestamp captured before the write or at the instant the refresh takes effect.

Let the old activity time be 1,000,000 ms, the request timestamp R be 1,060,001 ms, and the successful refresh take effect at W = 1,060,874 ms. The request is 60,001 ms after the old activity timestamp, so it is due under the stated strict threshold. Let D = 86,400,000 ms. Assuming the old session is still live when the refresh takes effect, the two anchors give:

| Interpretation                                                     | Lifetime anchor | New expiry         |
| ------------------------------------------------------------------ | --------------- | ------------------ |
| Refresh represents the activity timestamp captured for the request | R = 1,060,001   | R + D = 87,460,001 |
| Refresh represents the instant the update takes effect             | W = 1,060,874   | W + D = 87,460,874 |

The expiry instants differ by 873 ms. Under the original derivation's half-open validity convention, a read-only validity observation at time 87,460,002 is expired under the request anchor and still valid under the effect-time anchor. That observation must not itself refresh the session if it is being used to discriminate the two definitions.

**The brief does not unambiguously choose one anchor.** Mentioning request time in the throttle rule does not by itself define the lifetime anchor. The original derivation's statement that refresh sets activity to R and expiry to R+D was a chosen interpretation, not a uniquely compelled result. This amendment explicitly narrows that statement: an implementation using W+D must not be called defective solely because it differs from that reference choice, absent a more precise product or API contract.

Both interpretations must honor the unambiguous requirements: equality at age 60,000 ms is not due; missing or expired sessions cannot be revived by refresh; refresh cannot move activity backwards; logout must continue to prevent future authorization; and an already authorized request may finish after logout. The brief also does not settle the exact equality convention at the 24-hour expiry instant; the original half-open convention remains an identified assumption.
