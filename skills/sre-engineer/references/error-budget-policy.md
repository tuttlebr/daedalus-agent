# Error budgets and policy

For target S over a window, allowed error fraction is `1 - S`.
With N valid and B bad events, remaining allowed bad events are
`(1 - S) * N - B`; a negative value means exhaustion.
Burn rate is `observed_error_fraction / (1 - S)`, not fraction of budget used.

For a 30-day window, 14.4x burn consumes 2% of the budget in one hour;
6x consumes 5% in six hours. A 1x rate over six hours consumes about 0.83%,
not 5%. Match traffic, window and denominator before comparing budgets.

Use paired long/short alert windows to distinguish sustained burn from a
resolved spike; read [monitoring-alerting](monitoring-alerting.md).
These calculations follow Google's
[SLO alerting guidance](https://sre.google/workbook/alerting-on-slos/).

Propose an exhaustion policy with the actual service owner: which work should
pause, what reliability repairs remain allowed, evidence for exceptions and
recovery criteria. Do not invent executive approvals or freeze releases merely
because a generic example says so. Skill loading cannot authorize or prohibit
an external release on its own.

Validate empty traffic, missing series, exhausted budget and mismatched periods.
Retain exact query/window/source in the decision record.
