#!/usr/bin/env node
/* eslint-disable no-console */
// Draws a looping terminal animation (SVG, no JavaScript) from a timeline that
// scripts/demo/fallback.mjs recorded. GitHub renders animated SVG in README images.
// Usage: node scripts/demo/render-svg.mjs timeline.json assets/demo-fallback.svg
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: render-svg.mjs <timeline.json> <out.svg>');
  process.exit(2);
}
const timeline = JSON.parse(readFileSync(input, 'utf8'));

const W = 860;
const LINE = 22;
const TOP = 52;
const H = TOP + timeline.length * LINE + 24;
const HOLD_MS = 4000; // how long the finished screen stays before the loop restarts
const total = timeline.at(-1).at + HOLD_MS;
const colors = {
  cmd: '#e6edf3',
  note: '#8b949e',
  ok: '#3fb950',
  fallback: '#d29922',
  alert: '#f85149',
  error: '#f85149',
  done: '#3fb950',
  blank: '#e6edf3',
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (ms) => ((ms / total) * 100).toFixed(2);

const styles = [];
const lines = timeline.map((entry, i) => {
  const appear = pct(entry.at);
  styles.push(
    `.l${i}{animation:k${i} ${total}ms linear infinite}` +
      `@keyframes k${i}{0%,${appear}%{opacity:0}${(Number(appear) + 0.01).toFixed(2)}%,99.9%{opacity:1}100%{opacity:0}}`,
  );
  const weight = ['alert', 'done'].includes(entry.kind) ? ' font-weight="700"' : '';
  return `<text class="l${i}" x="20" y="${TOP + i * LINE}" fill="${colors[entry.kind] ?? '#e6edf3'}"${weight} xml:space="preserve">${esc(entry.text)}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Terminal recording: the primary LLM provider is killed mid-run and every request still succeeds through the fallback provider">
<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}${styles.join('')}@media (prefers-reduced-motion:reduce){text{animation:none!important;opacity:1!important}}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="30" rx="10" fill="#161b22"/><rect y="20" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="15" r="6" fill="#ff5f57"/><circle cx="40" cy="15" r="6" fill="#febc2e"/><circle cx="60" cy="15" r="6" fill="#28c840"/>
<text x="${W / 2}" y="20" fill="#8b949e" font-size="12" text-anchor="middle">node scripts/demo/fallback.mjs — recorded run</text>
${lines.join('\n')}
</svg>
`;
writeFileSync(output, svg);
console.log(`${output}: ${timeline.length} lines, ${(total / 1000).toFixed(1)} s loop`);
