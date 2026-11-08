/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { resetSessionForTests, restoreSession } from '../lib/session';
import ModelsPage, {
  comboDraft,
  executionOrder,
  validateAlias,
  validateComboDraft,
} from './models';

const modelsMessages = {
  title: 'Models & combos',
  subtitle: 'Manage public names, prices and routing policies.',
  catalogVersion: 'Catalog {{version}} · {{currency}}',
  models: 'Models',
  aliases: 'Aliases',
  combos: 'Combos',
  newModel: 'New model',
  editModel: 'Edit model',
  newAlias: 'New alias',
  editAlias: 'Edit alias',
  newCombo: 'New combo',
  editCombo: 'Edit combo',
  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  empty: 'No models yet.',
  noAliases: 'No aliases yet.',
  noCombos: 'No combos yet.',
  slug: 'Slug',
  provider: 'Provider',
  upstreamModel: 'Upstream model',
  displayName: 'Display name',
  contextWindow: 'Context window',
  maxOutputTokens: 'Max output',
  maxOutput: 'Max output',
  catalogKey: 'Catalog model',
  customModel: 'Custom model',
  perMTok: 'input / output per million tokens',
  enabled: 'Enabled',
  disabled: 'Disabled',
  aliasTarget: 'Target',
  chooseTarget: 'Choose a target',
  strategy: 'Strategy',
  targets: 'Targets',
  addTarget: 'Model',
  add: 'Add',
  weight: 'Weight',
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeTarget: 'Remove target',
  noTargets: 'Add at least one model.',
  dragHint: 'Drag targets to reorder, or use the move buttons.',
  fallbackOn: 'Fallback on errors',
  retryMaxAttempts: 'Attempts per target',
  timeouts: 'Timeouts (ms)',
  executionPreview: 'Execution preview',
  simulateNext: 'Simulate next request',
  targetCount: '{{count}} targets',
  confirmDelete: 'Delete this item?',
  column: {
    name: 'Model',
    upstream: 'Upstream',
    context: 'Context',
    pricing: 'Pricing (USD)',
    capabilities: 'Capabilities',
    status: 'Status',
    actions: 'Actions',
  },
  capability: {
    streaming: 'Streaming',
    tools: 'Tools',
    vision: 'Vision',
    reasoning: 'Reasoning',
    jsonMode: 'JSON mode',
  },
  price: {
    inputPerMTok: 'Input / MTok',
    outputPerMTok: 'Output / MTok',
    cacheReadPerMTok: 'Cache read / MTok',
    cacheWritePerMTok: 'Cache write / MTok',
    reasoningPerMTok: 'Reasoning / MTok',
  },
  strategyType: { priority: 'Priority', weighted: 'Weighted', 'round-robin': 'Round robin' },
  previewHelp: {
    priority: 'Targets are tried in the displayed order.',
    weighted: 'One weighted random order without replacement; percentages are first-pick weights.',
    'round-robin': 'The starting target rotates for each request.',
  },
  timeout: { connectMs: 'Connect', firstByteMs: 'First byte', idleMs: 'Idle', totalMs: 'Total' },
  errorClass: {
    rate_limit: 'Rate limit',
    overloaded: 'Overloaded',
    server: 'Server',
    timeout: 'Timeout',
    connection: 'Connection',
    auth: 'Authentication',
    bad_request: 'Bad request',
    context_length: 'Context length',
    content_filter: 'Content filter',
    not_found: 'Not found',
  },
  validation: {
    slug: 'Use letters, digits, dots, underscores, slashes or dashes.',
    targets: 'A combo needs 1–20 targets.',
    duplicateTarget: 'Each model can appear only once.',
    weight: 'Weights must be whole numbers from 0 to 1000.',
    attempts: 'Attempts must be a whole number from 1 to 10.',
    timeout: 'Timeouts must be positive whole numbers.',
    aliasTarget: 'Choose exactly one model or combo.',
    nameTaken: 'This name is already used by a model, alias or combo.',
    modelRequired: 'Provider and upstream model are required.',
    positiveInteger: 'Use positive whole numbers.',
    price: 'Prices must be non-negative decimal amounts with at most 8 decimal places.',
    basePrice: 'Input and output prices are required for a custom model.',
  },
};

const USER = {
  id: 'usr_1',
  email: 'owner@example.com',
  name: 'Owner',
  organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role: 'OWNER' }],
};
const MODELS = [
  {
    id: 'mdl_1',
    slug: 'openai/fast',
    providerId: 'prv_1',
    upstreamModel: 'gpt-fast',
    displayName: 'Fast model',
    enabled: true,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPerMTok: '2.5', outputPerMTok: '10' },
    capabilities: { streaming: true, tools: true, vision: false },
    catalogKey: 'openai/fast',
  },
  {
    id: 'mdl_2',
    slug: 'anthropic/deep',
    providerId: 'prv_2',
    upstreamModel: 'claude-deep',
    displayName: null,
    enabled: false,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    pricing: { inputPerMTok: '3', outputPerMTok: '15', reasoningPerMTok: '2' },
    capabilities: { streaming: true, reasoning: true, jsonMode: true },
    catalogKey: null,
  },
];
const COMBOS = [
  {
    id: 'cmb_1',
    slug: 'smart',
    strategy: 'weighted' as const,
    targets: [
      { modelId: 'mdl_1', order: 0, weight: 1 },
      { modelId: 'mdl_2', order: 1, weight: 3 },
    ],
    fallbackOn: ['rate_limit', 'timeout'],
    retryMaxAttempts: 2,
    timeouts: { connectMs: 5000, totalMs: 60000 },
  },
];
const ALIASES = [
  { id: 'als_1', slug: 'default', target: { kind: 'combo' as const, comboId: 'cmb_1' } },
];
const RESPONSES: Record<string, unknown> = {
  '/orgs/org_1/models': MODELS,
  '/orgs/org_1/combos': COMBOS,
  '/orgs/org_1/aliases': ALIASES,
  '/orgs/org_1/providers': [
    { id: 'prv_1', slug: 'openai', name: 'OpenAI', enabled: true },
    { id: 'prv_2', slug: 'anthropic', name: 'Anthropic', enabled: true },
  ],
  '/orgs/org_1/catalog': {
    version: '2026-11',
    currency: 'USD',
    models: [
      {
        key: 'openai/fast',
        upstreamModel: 'gpt-fast',
        displayName: 'Fast model',
        contextWindow: 128000,
        pricing: { inputPerMTok: '2.5', outputPerMTok: '10' },
        capabilities: { streaming: true, tools: true },
      },
    ],
  },
};

type Call = { path: string; init: RequestInit };
function mockApi() {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      calls.push({ path, init });
      const body =
        path === '/auth/refresh'
          ? { accessToken: 'token' }
          : path === '/auth/me'
            ? USER
            : path in RESPONSES
              ? RESPONSES[path]
              : { id: 'created' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

async function renderPage() {
  await act(async () => {
    await restoreSession();
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelsPage />
    </QueryClientProvider>,
  );
  expect(await screen.findByTestId('model-catalog-table')).toBeTruthy();
}

beforeEach(async () => {
  localStorage.clear();
  resetSessionForTests();
  setupI18n('en');
  i18n.addResourceBundle('en', 'translation', { models: modelsMessages }, true, true);
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('model and combo server-equivalent rules', () => {
  it('applies the same slug, target, weight, attempt and timeout bounds as the API', () => {
    const valid = comboDraft(COMBOS[0]);
    expect(validateComboDraft(valid)).toBeUndefined();
    expect(validateComboDraft({ ...valid, slug: 'Bad name!' })).toBe('models.validation.slug');
    expect(validateComboDraft({ ...valid, targets: [] })).toBe('models.validation.targets');
    expect(
      validateComboDraft({
        ...valid,
        targets: Array.from({ length: 21 }, (_, i) => ({ modelId: `m${i}`, order: i, weight: 1 })),
      }),
    ).toBe('models.validation.targets');
    expect(validateComboDraft({ ...valid, targets: [valid.targets[0]!, valid.targets[0]!] })).toBe(
      'models.validation.duplicateTarget',
    );
    expect(
      validateComboDraft({ ...valid, targets: [{ modelId: 'mdl_1', order: 0, weight: 1001 }] }),
    ).toBe('models.validation.weight');
    expect(validateComboDraft({ ...valid, retryMaxAttempts: '11' })).toBe(
      'models.validation.attempts',
    );
    expect(validateComboDraft({ ...valid, retryMaxAttempts: '0' })).toBe(
      'models.validation.attempts',
    );
    expect(validateComboDraft({ ...valid, timeouts: { ...valid.timeouts, totalMs: '1.5' } })).toBe(
      'models.validation.timeout',
    );
    expect(validateAlias({ slug: 'default', target: 'model:mdl_1' }, ['default'])).toBe(
      'models.validation.nameTaken',
    );
    expect(validateAlias({ slug: 'stable', target: '' }, [])).toBe('models.validation.aliasTarget');
  });

  it('matches gateway priority, weighted-without-replacement and round-robin ordering', () => {
    const weighted = comboDraft(COMBOS[0]);
    expect(executionOrder(weighted, 0, () => 0.6).map((target) => target.modelId)).toEqual([
      'mdl_2',
      'mdl_1',
    ]);
    expect(
      executionOrder({ ...weighted, strategy: 'priority' }).map((target) => target.modelId),
    ).toEqual(['mdl_1', 'mdl_2']);
    expect(
      executionOrder({ ...weighted, strategy: 'round-robin' }, 1).map((target) => target.modelId),
    ).toEqual(['mdl_2', 'mdl_1']);
    expect(
      executionOrder({ ...weighted, strategy: 'round-robin' }, 2).map((target) => target.modelId),
    ).toEqual(['mdl_1', 'mdl_2']);
  });
});

describe('model management UI', () => {
  it('shows catalog pricing, context and capability details', async () => {
    mockApi();
    await renderPage();
    expect(screen.getByText('128,000')).toBeTruthy();
    expect(screen.getByText('$2.5 / $10')).toBeTruthy();
    expect(screen.getAllByText('Streaming')).toHaveLength(2);
    expect(screen.getByText('JSON mode')).toBeTruthy();
    expect(screen.getByText('Catalog 2026-11 · USD')).toBeTruthy();
  });

  it('creates an alias with exactly one model target', async () => {
    const calls = mockApi();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'New alias' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'production' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'model:mdl_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(
        calls.some((call) => call.path === '/orgs/org_1/aliases' && call.init.method === 'POST'),
      ).toBe(true);
    });
    const call = calls.find(
      (item) => item.path === '/orgs/org_1/aliases' && item.init.method === 'POST',
    );
    expect(JSON.parse(call?.init.body as string)).toEqual({ slug: 'production', modelId: 'mdl_1' });
  });

  it('reorders combo targets with native drag and drop and saves normalized order', async () => {
    const calls = mockApi();
    await renderPage();
    const comboRow = screen.getByText('smart').closest('li');
    expect(comboRow).not.toBeNull();
    fireEvent.click(within(comboRow as HTMLLIElement).getByRole('button', { name: 'Edit' }));
    const targets = screen.getAllByTestId('combo-target');
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    fireEvent.dragStart(targets[0]!, { dataTransfer });
    fireEvent.dragOver(targets[1]!, { dataTransfer });
    fireEvent.drop(targets[1]!, { dataTransfer });
    const reordered = screen.getAllByTestId('combo-target');
    expect(reordered[0]?.textContent).toContain('anthropic/deep');
    expect(reordered[1]?.textContent).toContain('openai/fast');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.path === '/orgs/org_1/combos/cmb_1' && call.init.method === 'PATCH',
        ),
      ).toBe(true);
    });
    const call = calls.find(
      (item) => item.path === '/orgs/org_1/combos/cmb_1' && item.init.method === 'PATCH',
    );
    expect(JSON.parse(call?.init.body as string)).toEqual({
      slug: 'smart',
      strategy: 'weighted',
      targets: [
        { modelId: 'mdl_2', order: 0, weight: 3 },
        { modelId: 'mdl_1', order: 1, weight: 1 },
      ],
      fallbackOn: ['rate_limit', 'timeout'],
      retryMaxAttempts: 2,
      timeouts: { connectMs: 5000, totalMs: 60000 },
    });
  });

  it('blocks invalid combo input before making a request', async () => {
    const calls = mockApi();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'New combo' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'not valid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Use letters, digits, dots, underscores, slashes or dashes.',
    );
    expect(
      calls.some((call) => call.path === '/orgs/org_1/combos' && call.init.method === 'POST'),
    ).toBe(false);
  });
});
