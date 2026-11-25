/* eslint-disable no-console */
/**
 * Turns the output of an end-to-end runner (scripts/e2e/harness.mjs) into GitHub annotations:
 * job logs need a GitHub sign-in, annotations of a public run do not. One error per failed
 * scenario with its FAIL block, one warning listing skipped scenarios, and an error with the end
 * of the output when the runner crashed before its JSON summary.
 *
 *   node scripts/ci/e2e-annotations.mjs <stdout-file> <stderr-file> <runner-exit-status>
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// GitHub keeps at most 10 error annotations per step; the last slot lists the remaining failures.
const MAX_ERRORS = 10;
const BODY_LIMIT = 3500;

const escapeData = (text) =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (text) => escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
const annotate = (level, title, body) =>
  console.log(`::${level} title=${escapeProperty(title)}::${escapeData(body.slice(-BODY_LIMIT))}`);
const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n');

/** The runner prints its summary last, as pretty JSON starting with a `{` line. */
function parseSummary(stdout) {
  const at = stdout.lastIndexOf('\n{\n');
  const start = at === -1 ? (stdout.startsWith('{\n') ? 0 : -1) : at + 1;
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/** The `FAIL <name>` line and the indented stack lines the runner prints under it. */
function failBlock(stdout, name) {
  const lines = stdout.split('\n');
  const at = lines.indexOf(`FAIL ${name}`);
  if (at === -1) return '(no FAIL block in the output)';
  const block = [];
  for (let i = at + 1; i < lines.length && lines[i].startsWith('     '); i++) {
    block.push(lines[i].slice(5));
  }
  return block.join('\n');
}

const [stdoutFile, stderrFile, exitStatus = '0'] = process.argv.slice(2);
if (!stdoutFile) {
  console.error('usage: e2e-annotations.mjs <stdout-file> <stderr-file> <runner-exit-status>');
  process.exit(2);
}
const stdout = readFileSync(stdoutFile, 'utf8');
const stderr = stderrFile && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
const summary = parseSummary(stdout);
const markdown = [];

if (!summary) {
  annotate(
    'error',
    'E2E runner ended without a summary',
    `stdout:\n${tail(stdout, 30)}\n\nstderr:\n${tail(stderr, 30)}`,
  );
  markdown.push(
    '### End-to-end run ended without a summary',
    '```',
    tail(stderr || stdout, 60),
    '```',
  );
} else {
  const failed = summary.results.filter((r) => r.status === 'failed');
  const skipped = summary.results.filter((r) => r.status === 'skipped');
  const single = failed.length > MAX_ERRORS ? MAX_ERRORS - 1 : failed.length;
  for (const result of failed.slice(0, single)) {
    annotate('error', `E2E failed: ${result.name}`, failBlock(stdout, result.name));
  }
  if (failed.length > single) {
    annotate(
      'error',
      `E2E: ${String(failed.length - single)} more failed scenarios`,
      failed
        .slice(single)
        .map((r) => r.name)
        .join('\n'),
    );
  }
  if (skipped.length > 0) {
    annotate(
      'warning',
      `E2E: ${String(skipped.length)} skipped scenarios`,
      skipped.map((r) => `${r.name}: ${r.reason ?? ''}`).join('\n'),
    );
  }
  // Errors outside any scenario (a crash in setup, failed cleanups) only reach stderr; they fail
  // the run when the runner exits non-zero without a failed scenario.
  if (failed.length === 0 && (exitStatus !== '0' || stderr.trim())) {
    annotate(
      exitStatus === '0' ? 'warning' : 'error',
      'E2E runner errors outside scenarios',
      tail(stderr, 30) || '(no stderr output)',
    );
  }
  markdown.push(
    `### End-to-end: ${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.skipped)} skipped`,
    '',
    '| Scenario | Result |',
    '| --- | --- |',
    ...summary.results.map(
      (r) =>
        `| ${r.name.replaceAll('|', '\\|')} | ${r.status}${r.reason ? ` (${r.reason})` : ''} |`,
    ),
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.join('\n')}\n`);
}
