/**
 * DiRouter reference provider plugin: Cloudflare Workers AI's native API.
 *
 * Request:  POST {baseUrl}/accounts/{accountId}/ai/run/{model}
 *           { messages, max_tokens, temperature, stream }
 * Response: { success, result: { response, usage: { prompt_tokens, completion_tokens } } }
 * Stream:   SSE `data: {"response": "..."}`, then `data: [DONE]`
 *
 * Plugins run in a sandbox with only the JavaScript built-ins: no require, network or timers.
 * Use `log(...)` for diagnostics.
 */
'use strict';

function buildRequest(input) {
  var accountId = input.options.accountId;
  var base = input.baseUrl.replace(/\/+$/, '');
  var url = accountId
    ? base + '/accounts/' + encodeURIComponent(accountId) + '/ai/run/' + input.model
    : base + '/ai/run/' + input.model;
  var body = { messages: input.body.messages, stream: input.stream };
  if (input.body.max_tokens !== undefined) body.max_tokens = input.body.max_tokens;
  if (input.body.temperature !== undefined) body.temperature = input.body.temperature;
  if (input.body.top_p !== undefined) body.top_p = input.body.top_p;
  return {
    url: url,
    method: 'POST',
    headers: { authorization: 'Bearer ' + input.apiKey },
    body: body,
  };
}

function parseResponse(json) {
  var result = json.result || {};
  var usage = result.usage || {};
  return {
    id: 'workers-ai-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'workers-ai',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.response || '' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

var created = Math.floor(Date.now() / 1000);

function parseStreamEvent(json) {
  var chunk = {
    id: 'workers-ai-stream',
    object: 'chat.completion.chunk',
    created: created,
    model: 'workers-ai',
    choices: [],
  };
  if (json.usage) {
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    chunk.usage = {
      prompt_tokens: json.usage.prompt_tokens || 0,
      completion_tokens: json.usage.completion_tokens || 0,
      total_tokens: (json.usage.prompt_tokens || 0) + (json.usage.completion_tokens || 0),
    };
    return chunk;
  }
  if (!json.response) return null;
  chunk.choices = [{ index: 0, delta: { content: json.response }, finish_reason: null }];
  return chunk;
}

function listModels(input) {
  var base = input.baseUrl.replace(/\/+$/, '');
  return {
    url:
      base +
      '/accounts/' +
      encodeURIComponent(input.options.accountId || '') +
      '/ai/models/search?task=Text%20Generation',
    method: 'GET',
    headers: { authorization: 'Bearer ' + input.apiKey },
  };
}

function parseModelList(json) {
  return (json.result || []).map(function (m) {
    return m.name;
  });
}

module.exports = { buildRequest, parseResponse, parseStreamEvent, listModels, parseModelList };
