/** Conditional routing rules and their expression language (card 32.2). */
import { performance } from 'node:perf_hooks';

import type { RoutingRuleConfig, VirtualKeyConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { compileExpression, expressionProblem, type RuleInput } from './rules-expr.js';
import { RulesEngine } from './rules.js';

const input = (over: Partial<RuleInput['request']> = {}, budget?: RuleInput['budget']) => ({
  request: {
    model: 'gpt-big',
    api: 'openai.chat',
    stream: false,
    headers: { 'x-tier': 'gold', authorization: 'Bearer dr-secret' } as Record<string, string>,
    metadata: { feature: 'search' } as Record<string, string>,
    estimated_tokens: 1_200,
    max_output_tokens: 512,
    user: 'u-1',
    has_tools: false,
    has_images: false,
    ...over,
  },
  ...(budget ? { budget } : {}),
});
const full = (
  over: Partial<RuleInput['request']> = {},
  budget = { key: 0, project: 0, team: 0, max: 0 },
): RuleInput => ({
  ...input(over),
  key: { id: 'vk', project: 'prj', team: 'team-a', organization: 'org' },
  budget,
});
const key = (over: Partial<VirtualKeyConfig> = {}): VirtualKeyConfig => ({
  id: 'vk',
  hash: 'a'.repeat(64),
  prefix: 'dr-x',
  organizationId: 'org',
  teamId: 'team-a',
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
  allowedModels: [],
  ipAllowlist: [],
  budgets: [],
  mcpTools: [],
  repair: [],
  passthroughProviders: [],
  ...over,
});
let seq = 0;
const rule = (
  condition: string,
  action: RoutingRuleConfig['action'],
  over: Partial<RoutingRuleConfig> = {},
): RoutingRuleConfig => ({
  id: `rr_${String(++seq)}`,
  organizationId: 'org',
  name: `rule ${String(seq)}`,
  enabled: true,
  priority: seq * 10,
  condition,
  action,
  ...over,
});

describe('rule expressions', () => {
  it.each([
    ["request.headers['x-tier'] == 'gold'", true],
    ['request.headers.x_tier == null', true],
    ["request.metadata.feature in ['search', 'chat']", true],
    ['has(request.metadata.feature) && !has(request.metadata.other)', true],
    ['request.estimated_tokens + request.max_output_tokens > 1500', true],
    ['request.estimated_tokens * 2 >= 2400 && request.estimated_tokens % 7 == 3', true],
    ["request.model.startsWith('gpt-') && request.model.endsWith('big')", true],
    ["request.model.contains('bi') || false", true],
    ["key.team == 'team-a' && key.project != 'other'", true],
    ['budget.team > 80', true],
    ["size(request.model) == 7 && int('42') == 42 && string(3) == '3'", true],
    ["'x-tier' in request.headers && !('authorization' in request.headers)", true],
    ["request.headers['Authorization'] == null", true],
    ["request.headers['x-tier'].lowerAscii() == 'gold'", true],
    ['request.stream', false],
    ['-request.estimated_tokens < 0 && double(request.max_output_tokens) / 0 == null', true],
    ["[1, 2] == [1, 2] && 'b' > 'a'", true],
  ])('%s → %s', (source, expected) => {
    expect(
      compileExpression(source).evaluate(full({}, { key: 10, project: 0, team: 85, max: 85 })),
    ).toBe(expected);
  });

  it('hides credential headers from rules', () => {
    expect(
      compileExpression("request.headers['authorization'].startsWith('Bearer')").evaluate(full()),
    ).toBe(false);
  });

  it.each([
    ['request.nope == 1', 'unknown field'],
    ['secrets.x == 1', 'unknown variable'],
    ['request.model == 1', 'cannot compare'],
    ['request.model', 'must be true or false'],
    ['request == 1', 'group of variables'],
    ['request.model.matches(".*")', 'unknown method'],
    ['eval(1)', 'unknown function'],
    ["request.model == 'x", 'unterminated string'],
    ['1 +', 'expected a value'],
    ['request.stream && 1', 'expected bool'],
    ['(((((((((((((((((((((((((((((((((true)))))))))))))))))))))))))))))))))', 'nested too deeply'],
    ['true $ false', 'unexpected character'],
    ['true true', 'unexpected input'],
    [`'${'x'.repeat(2_100)}' == 'x'`, 'longer than'],
  ])('rejects %s', (source, problem) => {
    expect(expressionProblem(source)).toContain(problem);
  });

  it('marks expressions that read the budget', () => {
    expect(compileExpression('budget.team > 80').usesBudget).toBe(true);
    expect(compileExpression("request.model == 'budget'").usesBudget).toBe(false);
  });
});

describe('rules engine', () => {
  it('sends a team over 80% of its budget to the cheap model', () => {
    const engine = new RulesEngine([
      rule('budget.team > 80', { type: 'route', target: 'cheap' }, { name: 'team over budget' }),
    ]);
    const k = key();
    expect(engine.needsBudget(k)).toBe(true);
    const under = engine.evaluate(k, input({}, { key: 0, project: 0, team: 79.9, max: 79.9 }));
    expect(under.target).toBeUndefined();
    const over = engine.evaluate(k, input({}, { key: 0, project: 0, team: 81, max: 81 }));
    expect(over.target).toBe('cheap');
    expect(over.decidedBy?.name).toBe('team over budget');
  });

  it('runs in priority order: tags accumulate, the first route or reject decides', () => {
    const tag = rule('true', { type: 'tag', tags: { tier: 'gold' } }, { priority: 1 });
    const reject = rule(
      "request.metadata.feature == 'search'",
      { type: 'reject', message: 'search is off', status: 403 },
      { priority: 2 },
    );
    const route = rule('true', { type: 'route', target: 'never' }, { priority: 3 });
    const decision = new RulesEngine([route, reject, tag]).evaluate(key(), input());
    expect(decision.matched).toEqual([tag.id, reject.id]);
    expect(decision.tags).toEqual({ tier: 'gold' });
    expect(decision.reject).toEqual({ message: 'search is off', status: 403 });
    expect(decision.target).toBeUndefined();
  });

  it('keeps team and project policies to their own keys and organizations apart', () => {
    const teamRule = rule('true', { type: 'route', target: 'team-model' }, { teamId: 'team-a' });
    const projectRule = rule('true', { type: 'route', target: 'p' }, { projectId: 'other' });
    const other = rule('true', { type: 'route', target: 'x' }, { organizationId: 'org-2' });
    const engine = new RulesEngine([projectRule, teamRule, other]);
    expect(engine.evaluate(key(), input()).target).toBe('team-model');
    expect(engine.evaluate(key({ teamId: 'team-b' }), input()).target).toBeUndefined();
    expect(engine.evaluate(key({ organizationId: 'org-3' }), input()).matched).toEqual([]);
    expect(engine.has(key({ organizationId: 'org-3' }))).toBe(false);
  });

  it('skips disabled rules and reports rules that do not compile', () => {
    const off = rule('true', { type: 'route', target: 'x' }, { enabled: false });
    const broken = rule('request.nope', { type: 'route', target: 'x' });
    const engine = new RulesEngine([off, broken]);
    expect(engine.evaluate(key(), input()).matched).toEqual([]);
    expect(engine.invalid.get(broken.id)).toContain('unknown field');
  });

  it('adds under 0.2 ms to a request with a realistic rule set', () => {
    const rules = [
      ...Array.from({ length: 18 }, (_, i) =>
        rule(
          `request.headers['x-tier'] == 'tier-${String(i)}' && request.estimated_tokens > ${String(i * 100)}`,
          { type: 'route', target: `m${String(i)}` },
        ),
      ),
      rule("request.metadata.feature in ['a', 'b', 'c'] || key.team == 'zzz'", {
        type: 'tag',
        tags: { f: 'x' },
      }),
      rule('budget.team > 80 && request.model.startsWith("gpt")', {
        type: 'route',
        target: 'cheap',
      }),
    ];
    const engine = new RulesEngine(rules);
    const k = key();
    const req = input({}, { key: 1, project: 2, team: 50, max: 50 });
    for (let i = 0; i < 2_000; i++) engine.evaluate(k, req);
    const runs = 20_000;
    const started = performance.now();
    for (let i = 0; i < runs; i++) engine.evaluate(k, req);
    const perRequestMs = (performance.now() - started) / runs;
    expect(perRequestMs).toBeLessThan(0.2);
  });
});
