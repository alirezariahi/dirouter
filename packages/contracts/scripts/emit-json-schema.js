// Emits the JSON Schema of all schemas to dist/json-schema (runs after tsc).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { schemaRegistry, toJsonSchema } from '../dist/index.js';

const outDir = join(import.meta.dirname, '..', 'dist', 'json-schema');
mkdirSync(outDir, { recursive: true });

for (const name of Object.keys(schemaRegistry)) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(toJsonSchema(name), null, 2)}\n`);
}
