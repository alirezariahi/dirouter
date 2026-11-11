/* eslint-disable no-console */
import { readFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

const files = globSync('{apps,packages}/*/coverage/coverage-summary.json', {
  cwd: resolve(import.meta.dirname, '../..'),
});
const rows = files.map((file) => {
  const report = JSON.parse(readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8'));
  const total = report.total;
  const format = (metric) => `${metric.pct.toFixed(2)}%`;
  return `| ${file.split('/coverage/')[0]} | ${format(total.statements)} | ${format(total.branches)} | ${format(total.functions)} | ${format(total.lines)} |`;
});
if (files.length === 0) {
  console.log('No Vitest coverage reports were generated.');
} else {
  console.log('## Vitest coverage\n');
  console.log(
    '| Package | Statements | Branches | Functions | Lines |\n| --- | ---: | ---: | ---: | ---: |',
  );
  console.log(rows.join('\n'));
}
