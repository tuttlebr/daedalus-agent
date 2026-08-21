import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUDIT_ARGUMENTS = [
  'audit',
  '--omit=dev',
  '--audit-level=moderate',
  '--package-lock-only',
  '--json',
];

const SEVERITY = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

// These exact moderate advisories have no published fix. Keep this list
// source-ID-specific so any new advisory, severity increase, or available fix
// fails the gate and requires an explicit review.
const ALLOWED_NO_FIX_ADVISORIES = new Map([
  [
    1138538,
    {
      name: 'dompurify',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-55q2-fjhq-7xh7',
    },
  ],
  [
    1138099,
    {
      name: 'mermaid',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-6x64-9x62-f2gx',
    },
  ],
  [
    1138100,
    {
      name: 'mermaid',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-3rrr-jr9j-h3q3',
    },
  ],
  [
    1138101,
    {
      name: 'mermaid',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-2v8p-3f2j-5mp7',
    },
  ],
  [
    1138113,
    {
      name: 'mermaid',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-rhh3-jpg6-66xh',
    },
  ],
  [
    1130709,
    {
      name: 'postcss',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-fxqj-rqcc-2cmp',
    },
  ],
]);

function isAtLeastModerate(severity) {
  return (SEVERITY.get(severity) ?? Number.POSITIVE_INFINITY) >= 2;
}

function collectAdvisories(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);

  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) return [];

  return vulnerability.via.flatMap((entry) => {
    if (typeof entry === 'string') {
      return collectAdvisories(vulnerabilities, entry, seen);
    }
    return entry && isAtLeastModerate(entry.severity) ? [entry] : [];
  });
}

export function evaluateAuditReport(report) {
  const violations = [];
  const allowed = new Map();
  const vulnerabilities = report?.vulnerabilities;

  if (report?.auditReportVersion !== 2 || !vulnerabilities) {
    return {
      allowed: [],
      violations: ['npm returned an invalid or unsupported audit report'],
    };
  }

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!isAtLeastModerate(vulnerability.severity)) continue;

    if (vulnerability.fixAvailable !== false) {
      violations.push(`${name}: npm reports that a fix is available`);
      continue;
    }

    const advisories = collectAdvisories(vulnerabilities, name);
    if (advisories.length === 0) {
      violations.push(`${name}: no reviewable advisory details were returned`);
      continue;
    }

    for (const advisory of advisories) {
      const expected = ALLOWED_NO_FIX_ADVISORIES.get(advisory.source);
      if (
        !expected ||
        advisory.name !== expected.name ||
        advisory.severity !== expected.severity ||
        advisory.url !== expected.url
      ) {
        violations.push(
          `${name}: unapproved ${advisory.severity} advisory ${
            advisory.url ?? advisory.source
          }`,
        );
        continue;
      }
      allowed.set(advisory.source, expected);
    }
  }

  return { allowed: [...allowed.values()], violations };
}

function main() {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    AUDIT_ARGUMENTS,
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr);
    throw new Error('npm audit did not return valid JSON');
  }

  if (![0, 1].includes(result.status)) {
    process.stderr.write(result.stderr);
    throw new Error(
      `npm audit exited unexpectedly with status ${result.status}`,
    );
  }

  const evaluation = evaluateAuditReport(report);
  if (evaluation.violations.length > 0) {
    for (const violation of evaluation.violations) {
      console.error(`npm audit policy violation: ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  if (evaluation.allowed.length === 0) {
    console.log(
      'Production npm audit passed with no moderate-or-higher findings.',
    );
    return;
  }

  console.log(
    `Production npm audit passed with ${evaluation.allowed.length} reviewed no-fix advisories:`,
  );
  for (const advisory of evaluation.allowed) console.log(`- ${advisory.url}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
