import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Direct mock-provider and gateway runs use identical payloads and timing.
const duration = __ENV.DURATION || '60s';
const target = __ENV.TARGET || 'gateway';
// The `combined` scenario also runs against the gateway (both the non-stream
// and the stream scenario at once), so it needs the same routing headers and
// virtual key as a plain gateway run.
const viaGateway = target === 'gateway' || target === 'combined';
const rate = Number(__ENV.RATE || (viaGateway ? 1000 : 500));
const stream = (__ENV.STREAM || 'false') === 'true';
const mode = __ENV.MODE || (stream ? 'stream' : 'nonstream');
const route = viaGateway ? 'gateway' : 'direct';
const latency = new Trend('request_latency_ms', true);
const requests = new Counter('scenario_requests');
const failedRequests = new Counter('failed_requests');

function scenario(name, requestsPerSecond, isStream) {
  return {
    executor: 'constant-arrival-rate',
    rate: requestsPerSecond,
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Number(__ENV.PRE_VUS || (isStream ? 250 : 200)),
    maxVUs: Number(__ENV.MAX_VUS || (isStream ? 1500 : 1200)),
    exec: isStream ? 'streamRequest' : 'nonstreamRequest',
    tags: { scenario: name },
    gracefulStop: '30s',
  };
}

export const options = {
  scenarios:
    target === 'combined'
      ? { nonstream: scenario('nonstream', 1000, false), stream: scenario('stream', 500, true) }
      : { [route]: scenario(route, rate, mode === 'stream') },
  thresholds: {
    http_req_failed: ['rate==0'],
    // The k6 client itself shares the host with the services under test, so a
    // small number of dropped iterations is tolerated; the offered load is
    // reported separately via http_reqs rate.
    dropped_iterations: ['rate<0.02'],
  },
  discardResponseBodies: false,
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const baseUrl =
  __ENV.BASE_URL ||
  (target === 'gateway'
    ? 'http://host.docker.internal:18080'
    : 'http://host.docker.internal:18090');
const apiKey =
  __ENV.API_KEY || (target === 'gateway' ? 'dr-benchmark-000000000000000001' : 'sk-mock');
const requestHeaders = {
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
  ...(viaGateway ? { host: 'gateway.localhost' } : {}),
};
const body = (isStream) =>
  JSON.stringify({
    model: 'mock/small',
    messages: [{ role: 'user', content: 'Hello, how are you today?' }],
    stream: isStream,
    ...(isStream ? { stream_options: { include_usage: true } } : {}),
  });

function send(isStream) {
  const response = http.post(`${baseUrl}/v1/chat/completions`, body(isStream), {
    headers: requestHeaders,
    timeout: '30s',
    tags: { endpoint: isStream ? 'stream' : 'nonstream' },
  });
  const ok = check(response, {
    'status is 200': (r) => r.status === 200,
    'complete response': (r) =>
      isStream
        ? r.body.includes('data: [DONE]')
        : (() => {
            try {
              return (
                JSON.parse(r.body).choices[0].message.content ===
                'Hello from the DiRouter mock provider.'
              );
            } catch {
              return false;
            }
          })(),
  });
  requests.add(1);
  latency.add(response.timings.duration);
  if (!ok) failedRequests.add(1);
}

export function nonstreamRequest() {
  send(false);
}
export function streamRequest() {
  send(true);
}
