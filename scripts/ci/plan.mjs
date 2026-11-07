import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const applications = [
  { app: 'gateway', port: 8080 },
  { app: 'control-api', port: 3000 },
  { app: 'worker', port: 3100 },
  { app: 'mock-provider', port: 8090 },
  { app: 'dashboard', port: 8080 },
].map((app) => ({
  ...app,
  dockerfile: `deploy/docker/${app.app === 'dashboard' ? 'dashboard' : 'node'}.Dockerfile`,
}));

const globalFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  '.nvmrc',
  '.npmrc',
  'eslint.config.js',
  '.prettierrc.json',
]);

const execute = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

/** Resolve a concrete commit range; never interpolate branch names into a shell. */
export function plan({ eventName, event = {}, ref = '', head }, run = execute) {
  let base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  let full = eventName === 'workflow_dispatch' || ref.startsWith('refs/tags/');

  if (ref.startsWith('refs/tags/')) {
    // SemVer 2.0, including prereleases and build metadata. Reject misleading v* tags.
    const numeric = '(?:0|[1-9][0-9]*)';
    const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
    const semver = new RegExp(
      `^refs/tags/v${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    );
    if (!semver.test(ref)) throw new Error('Release tags must have the form v<semver>');
  }

  if (!full) {
    // New branches, rewritten/unavailable history: check everything, never silently skip.
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) full = true;
    else {
      try {
        base = run('git', ['merge-base', base, head]);
      } catch {
        full = true;
      }
    }
  }

  const changed = full
    ? []
    : run('git', ['diff', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
  if (changed.some((file) => globalFiles.has(file) || /^(?:\.github|scripts\/ci)\//.test(file))) {
    full = true;
  }

  const filter = full ? '*' : `...[${base}...${head}]`;
  const dry = JSON.parse(
    run('pnpm', ['exec', 'turbo', 'run', 'build', `--filter=${filter}`, '--dry=json']),
  );
  const packages = new Set(dry.packages);
  // Turbo may select the workspace root (//) for README/docs changes; it has no app tasks.
  packages.delete('//');
  const include = applications.filter(({ app }) => {
    if (full || packages.has(`@dirouter/${app}`) || changed.includes('.dockerignore')) return true;
    if (app === 'dashboard') {
      return changed.some(
        (file) =>
          file === 'deploy/docker/dashboard.Dockerfile' || file.startsWith('deploy/docker/nginx/'),
      );
    }
    return changed.includes('deploy/docker/node.Dockerfile');
  });
  return {
    filter,
    matrix: { include },
    hasImages: include.length > 0,
    hasPackages: packages.size > 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = plan({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    head: process.env.GITHUB_SHA,
    event,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `filter=${result.filter}\nmatrix=${JSON.stringify(result.matrix)}\nhas-images=${result.hasImages}\nhas-packages=${result.hasPackages}\n`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### CI plan\n\nTurbo filter: \`${result.filter}\`\n\nImages: ${result.matrix.include.map(({ app }) => app).join(', ') || '(none)'}\n`,
  );
}
