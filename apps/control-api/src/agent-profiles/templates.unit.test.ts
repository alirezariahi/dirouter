import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_TOOLS, generateProfile, installScript } from './templates.js';

const base = {
  slug: 'team-claude',
  gatewayUrl: 'https://api.example.com/',
  apiKey: "dr-abc'quote",
  mainModel: 'anthropic/claude-sonnet',
  fastModel: 'anthropic/claude-haiku',
};

describe('agent profile templates', () => {
  it('Claude Code: settings with the gateway, key and a model per role', () => {
    const [envFile, settings, launcher] = generateProfile({
      ...base,
      tool: 'claude-code',
      disableNonessentialTraffic: true,
    });
    expect(JSON.parse(settings?.content ?? '')).toEqual({
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: "dr-abc'quote",
        ANTHROPIC_MODEL: 'anthropic/claude-sonnet',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }) as unknown,
    });
    expect(envFile?.content).toContain("ANTHROPIC_AUTH_TOKEN='dr-abc'\"'\"'quote'");
    expect(launcher?.content).toContain('. "$DIR/claude-code.env"');
    expect(launcher?.content).toContain('exec claude "$@"');
  });

  it('Codex: its own CODEX_HOME with the DiRouter provider and a fast profile', () => {
    const [config, launcher] = generateProfile({ ...base, tool: 'codex' });
    expect(config?.content).toContain('base_url = "https://api.example.com/v1"');
    expect(config?.content).toContain('[profiles.fast]\nmodel = "anthropic/claude-haiku"');
    expect(launcher?.content).toContain('CODEX_HOME="$DIR/codex"');
  });

  it('every tool generates parseable files', () => {
    for (const tool of AGENT_TOOLS) {
      const files = generateProfile({ ...base, tool });
      expect(files.length).toBeGreaterThan(0);
      for (const f of files)
        if (f.name.endsWith('.json')) expect(() => JSON.parse(f.content) as unknown).not.toThrow();
    }
  });

  it('the installer is valid shell, writes owner-only files and launchers, and quotes the key', () => {
    const home = mkdtempSync(join(tmpdir(), 'dirouter-profile-'));
    const script = join(home, 'install.sh');
    for (const tool of ['claude-code', 'codex'] as const) {
      writeFileSync(script, installScript(base.slug, generateProfile({ ...base, tool })));
      execFileSync('sh', ['-n', script]);
      execFileSync('sh', [script], { env: { ...process.env, HOME: home } });
    }
    const dir = join(home, '.config/dirouter/team-claude');
    expect(statSync(join(dir, 'claude-code.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf8'))).toMatchObject({
      env: { ANTHROPIC_AUTH_TOKEN: "dr-abc'quote" },
    });
    expect(readlinkSync(join(home, '.local/bin/codex-dirouter'))).toBe(join(dir, 'codex-dirouter'));
    // The quoted key survives the shell: the launcher exports it unchanged.
    const printed = execFileSync(
      'sh',
      [
        '-c',
        readFileSync(join(dir, 'codex-dirouter'), 'utf8').replace(
          'exec codex',
          'printenv DIROUTER_API_KEY #',
        ),
      ],
      { env: { ...process.env, HOME: home } },
    ).toString();
    expect(printed.trim()).toBe("dr-abc'quote");
  });
});
