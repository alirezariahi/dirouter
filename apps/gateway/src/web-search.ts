/**
 * Extension point for web search (the `:online` model suffix, card 31.5). The search itself is
 * card 30.8: it provides an implementation of this interface, passed to `buildGateway` as
 * `webSearch`. Without one, a request with `:online` fails with 400 `web_search_unavailable`
 * instead of silently answering without search.
 */
import type { CanonicalRequest } from '@dirouter/contracts';

export interface WebSearchContext {
  organizationId: string;
  projectId: string;
  virtualKeyId: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface WebSearchExtension {
  /** Whether a search can be served now (switched on, a backend configured); absent means yes. */
  available?: () => boolean;
  /**
   * Returns the request with web results added (for example as a system message with sources).
   * May throw a `DiRouterError`, which reaches the client as is.
   */
  augment(request: CanonicalRequest, context: WebSearchContext): Promise<CanonicalRequest>;
}
