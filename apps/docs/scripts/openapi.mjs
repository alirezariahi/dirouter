/**
 * The control-api reference page, generated from its OpenAPI document (card 22.5): every
 * operation grouped by tag, with its permission, parameters and the top-level fields of its body.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const TEXT = {
  title: 'Control API reference',
  intro:
    'Generated from the OpenAPI document the control-api exports (`apps/dashboard/openapi.json`). All paths are under the API origin, for example `https://admin.example.com`.',
  operations: 'operations',
  method: 'Method',
  path: 'Path',
  about: 'Description',
  body: 'Body fields',
  untagged: 'Other',
};

const escape = (value) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();

function resolve(schema, doc) {
  if (schema?.$ref) {
    const name = schema.$ref.split('/').at(-1);
    return doc.components?.schemas?.[name] ?? {};
  }
  return schema ?? {};
}

function bodyFields(operation, doc) {
  const content = operation.requestBody?.content ?? {};
  const schema = resolve(Object.values(content)[0]?.schema, doc);
  const variants = schema.anyOf ?? schema.oneOf ?? [schema];
  const fields = new Set();
  const required = new Set();
  for (const variant of variants.map((v) => resolve(v, doc))) {
    for (const name of Object.keys(variant.properties ?? {})) fields.add(name);
    for (const name of variant.required ?? []) required.add(name);
  }
  return [...fields]
    .map((name) => (required.has(name) ? `\`${name}\`*` : `\`${name}\``))
    .join(', ');
}

export function apiReference(doc) {
  const t = TEXT;
  const groups = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const tag = operation.tags?.[0] ?? t.untagged;
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push({ method, path, operation });
    }
  }
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, operations]) => {
      const rows = operations
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method),
        )
        .map(
          ({ method, path, operation }) =>
            `| \`${method.toUpperCase()}\` | \`${escape(path)}\` | ${escape(operation.summary ?? operation.description)} | ${bodyFields(operation, doc)} |`,
        );
      return [
        `## ${tag}`,
        '',
        `${String(operations.length)} ${t.operations}`,
        '',
        `| ${t.method} | ${t.path} | ${t.about} | ${t.body} |`,
        '| --- | --- | --- | --- |',
        ...rows,
        '',
      ].join('\n');
    });
  const version = doc.info?.version ? ` (${doc.info.version})` : '';
  return `---\ntitle: ${JSON.stringify(t.title + version)}\n---\n\n${t.intro}\n\n${sections.join('\n')}`;
}
