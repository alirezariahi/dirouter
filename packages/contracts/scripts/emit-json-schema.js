// خروجی JSON Schema همهٔ اسکیماها در dist/json-schema (بعد از tsc اجرا می‌شود).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { schemaRegistry, toJsonSchema } from '../dist/index.js';

const outDir = join(import.meta.dirname, '..', 'dist', 'json-schema');
mkdirSync(outDir, { recursive: true });

for (const name of Object.keys(schemaRegistry)) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(toJsonSchema(name), null, 2)}\n`);
}
