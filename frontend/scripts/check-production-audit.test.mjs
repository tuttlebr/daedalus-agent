import { evaluateAuditReport } from './check-production-audit.mjs';

import { describe, expect, it } from 'vitest';

function report(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities };
}

const postcssAdvisory = {
  source: 1130709,
  name: 'postcss',
  severity: 'moderate',
  url: 'https://github.com/advisories/GHSA-fxqj-rqcc-2cmp',
};

describe('production npm audit policy', () => {
  it('rejects a formerly reviewed advisory after a fix is published', () => {
    const evaluation = evaluateAuditReport(
      report({
        postcss: {
          severity: 'moderate',
          fixAvailable: false,
          via: [postcssAdvisory],
        },
        next: {
          severity: 'moderate',
          fixAvailable: false,
          via: ['postcss'],
        },
      }),
    );

    expect(evaluation.violations).toEqual([
      'postcss: unapproved moderate advisory https://github.com/advisories/GHSA-fxqj-rqcc-2cmp',
      'next: unapproved moderate advisory https://github.com/advisories/GHSA-fxqj-rqcc-2cmp',
    ]);
    expect(evaluation.allowed).toEqual([]);
  });

  it('rejects an unknown moderate advisory', () => {
    const evaluation = evaluateAuditReport(
      report({
        dependency: {
          severity: 'moderate',
          fixAvailable: false,
          via: [
            {
              source: 9999999,
              name: 'dependency',
              severity: 'moderate',
              url: 'https://example.invalid/advisory',
            },
          ],
        },
      }),
    );

    expect(evaluation.violations).toEqual([
      'dependency: unapproved moderate advisory https://example.invalid/advisory',
    ]);
  });

  it('rejects an allowlisted advisory once npm reports a fix', () => {
    const evaluation = evaluateAuditReport(
      report({
        postcss: {
          severity: 'moderate',
          fixAvailable: {
            name: 'postcss',
            version: '8.5.23',
            isSemVerMajor: false,
          },
          via: [postcssAdvisory],
        },
      }),
    );

    expect(evaluation.violations).toEqual([
      'postcss: npm reports that a fix is available',
    ]);
  });

  it('rejects malformed audit output', () => {
    expect(evaluateAuditReport({}).violations).toEqual([
      'npm returned an invalid or unsupported audit report',
    ]);
  });
});
