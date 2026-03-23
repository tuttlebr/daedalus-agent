# Quick Reference Checklist

A condensed version of the full code review checklist for rapid scanning.

## Must-Pass (Critical)

- [ ] No unvalidated user input reaches database queries or shell commands
- [ ] No secrets or credentials in source code
- [ ] Error handling does not swallow exceptions silently
- [ ] All public API contracts are honoured

## Should-Pass (Warning)

- [ ] Edge cases documented and tested
- [ ] Performance-sensitive paths benchmarked
- [ ] Dependencies pinned to specific versions
- [ ] Logging is structured and at appropriate levels

## Nice-to-Have (Info)

- [ ] Code coverage above target threshold
- [ ] README or docstrings updated for new functionality
- [ ] Consistent naming conventions throughout
