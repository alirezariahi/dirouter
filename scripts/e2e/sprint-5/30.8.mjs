/**
 * Card 30.8: web search and web fetch as a service. The development gateway searches the mock
 * provider's fake SearXNG, Brave and Tavily backends (WEB_SEARCH_* in compose.dev.yaml).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, request, sql, urls, waitFor } from '../harness.mjs';

const HINT = 'is the dev gateway running with the WEB_SEARCH_* variables of compose.dev.yaml?';

export async function register({ scenario, createKey }) {
  let key;
  const setup = async () => {
    key ??= await createKey('web-search');
  };

  /** A chat in online mode on a model without native search, checked for a 200. */
  const online = async () => {
    await setup();
    const { response, body } = await chat(key.key, {
      model: 'mock/small',
      // A fresh question, so the search is not answered from the cache (which costs nothing).
      messages: [{ role: 'user', content: `What changed in DiRouter ${randomUUID()}?` }],
      plugins: [{ id: 'web', max_results: 2 }],
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.notEqual(response.headers.get('x-dirouter-web-search'), 'unavailable', HINT);
    return { response, body };
  };

  await scenario(
    '30.8 a model without native search answers with sources in online mode',
    async () => {
      const { body } = await online();
      const annotations = body.choices[0].message.annotations ?? [];
      assert.equal(annotations.length, 2);
      assert.equal(annotations[0].type, 'url_citation');
      assert.match(annotations[0].url_citation.url, /\/web\/page\/1/);
    },
  );

  await scenario('30.8 search cost is a separate usage row next to the model call', async () => {
    const onlineRequestId = (await online()).response.headers.get('x-request-id');
    let rows = '';
    await waitFor('the search and chat rows in request_log', async () => {
      rows = await sql(
        `SELECT inbound_api, requested_model, cost_usd > 0 FROM request_log
          WHERE api_key_id = '${key.id}'
            AND (id = '${onlineRequestId}' OR id LIKE '${onlineRequestId}:web_search:%')
          ORDER BY inbound_api`,
      );
      return rows.split('\n').length === 2;
    });
    const [chatRow, searchRow] = rows.split('\n').map((line) => line.split('|'));
    assert.equal(chatRow[0], 'openai.chat');
    assert.equal(searchRow[0], 'web.search');
    assert.match(searchRow[1], /^web_search:/);
    assert.equal(searchRow[2], 't');
  });

  await scenario(
    '30.8 Claude Code with a non-Anthropic model gets web_search results',
    async () => {
      await setup();
      const { response, body } = await request(
        `${urls.gateway}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key.key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'mock/small',
            max_tokens: 512,
            system: 'You are an assistant for performing a web search tool use',
            messages: [
              {
                role: 'user',
                content: `Perform a web search for the query: dirouter ${randomUUID()}`,
              },
            ],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          }),
        },
        200,
      );
      const types = body.content.map((block) => block.type);
      assert.deepEqual(types, ['server_tool_use', 'web_search_tool_result', 'text'], HINT);
      assert.ok(body.content[1].content.length > 0);
      assert.equal(body.content[1].content[0].type, 'web_search_result');
      assert.match(body.content[2].text, /\/web\/page\//);
      assert.equal(body.usage.server_tool_use.web_search_requests, 1);
      assert.ok(response.headers.get('x-request-id'));
    },
  );

  await scenario('30.8 web fetch reads a page as text and refuses other schemes', async () => {
    await setup();
    const fetchPage = (url) =>
      request(`${urls.gateway}/v1/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ url }),
      });
    const page = await fetchPage('http://mock-provider:8090/web/page/1');
    assert.equal(page.response.status, 200, page.text);
    assert.equal(page.body.title, 'Mock page 1');
    assert.match(page.body.content, /Facts & figures/);
    assert.doesNotMatch(page.body.content, /never shown/);
    assert.equal((await fetchPage('file:///etc/passwd')).response.status, 400);
  });
}
