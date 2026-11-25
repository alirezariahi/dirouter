/**
 * Guardrails in the gateway (cards 15.1 and 23.1). The engine lives in @dirouter/contracts so the
 * panel's live test runs the same code; this module adds the streaming side.
 */
import {
  evaluateGuardrails,
  type ExternalVerdict,
  externalPolicies,
  pendingPrivateKeyStart,
  type CanonicalResponse,
  type GuardrailHit,
  type GuardrailPolicy,
} from '@dirouter/contracts';

export {
  evaluateGuardrails,
  iranNationalIdValid,
  isSafePattern,
  luhnValid,
  policiesFor,
  type GuardrailInput,
  type GuardrailResult,
} from '@dirouter/contracts';

/** A held PEM block longer than this is evaluated anyway (and, being unterminated, redacted whole). */
const MAX_HELD_KEY = 16_384;
/** `json_schema` holds the whole answer; past this size it is evaluated as it stands. */
export const MAX_HELD_ANSWER = 1_048_576;

/**
 * Cross-chunk response guardrails for streaming (cards 15.1 and 23.1).
 *
 * Matches can straddle SSE deltas, so text is held in a small tail buffer (default 256 chars) before
 * being released: the buffer is checked on every push and only the part that can no longer contain
 * a match is emitted. A blocking policy aborts the stream with an error event.
 *
 * Two policy types need more than a window:
 * - `secret`: a PEM private key is held from its BEGIN line until its END line arrives, so the
 *   block is redacted or blocked as a whole and no line of it leaks.
 * - `json_schema` with `block`: the answer can only be judged once complete, so all text is held
 *   until the end of the stream. With `flag` the text flows and the verdict is recorded at the end.
 * - `moderation`, and `prompt_injection` with a classifier (cards 23.2 and 23.3), judge the whole
 *   answer the same way. Their model call is async: the caller asks `pendingJudgement()` before
 *   `finish()`, makes the calls and hands the verdicts over with `setVerdicts()`.
 */
export class StreamGuardrailBuffer {
  #buffer = '';
  #policies: readonly GuardrailPolicy[];
  /** Policies applied chunk by chunk (everything that does not judge the whole answer). */
  #windowed: readonly GuardrailPolicy[];
  /** Whole-answer policies: `json_schema` and the ones that need a model call. */
  #schema: readonly GuardrailPolicy[];
  #external: readonly GuardrailPolicy[];
  #verdicts: ReadonlyMap<string, ExternalVerdict> | undefined;
  #holdAll: boolean;
  #holdKeys: boolean;
  #window: number;
  /** Whole answer as released, for `json_schema` policies that do not hold the stream. */
  #answer = '';
  /** The `json_schema` verdict has been given. */
  #judged = false;
  #hits: GuardrailHit[] = [];
  #unknown = new Map<string, GuardrailPolicy>();

  constructor(policies: readonly GuardrailPolicy[], window = 256) {
    this.#policies = policies.filter(
      (policy) => policy.enabled && (policy.stage === 'response' || policy.stage === 'both'),
    );
    this.#external = externalPolicies(this.#policies, 'response');
    const whole = (p: GuardrailPolicy) => p.type === 'json_schema' || this.#external.includes(p);
    this.#windowed = this.#policies.filter((p) => !whole(p));
    this.#schema = this.#policies.filter(whole);
    this.#holdAll = this.#schema.some((p) => p.action === 'block');
    this.#holdKeys = this.#policies.some((p) => p.type === 'secret');
    this.#window = Math.max(64, window);
  }

  get active(): boolean {
    return this.#policies.length > 0;
  }

  /**
   * A blocking policy judges the whole answer (`json_schema`, `moderation`, a classifier): the
   * caller must hold every stream event, not only text, until the end, judge the full answer with
   * `judgeWhole()` and replay the events through `guardBlock()`. Releasing text before a later
   * block would let that block skip the verdict.
   */
  get holdsWholeAnswer(): boolean {
    return this.active && this.#schema.some((p) => p.action === 'block');
  }

  /** Whole-answer policies that need a model call (moderation, classifiers). */
  get externalPolicies(): readonly GuardrailPolicy[] {
    return this.#external;
  }

  /** The verdict of the whole-answer policies on the complete answer text (hold-all mode). */
  judgeWhole(text: string): { blocked?: string } {
    this.#judged = true;
    if (text.length > MAX_HELD_ANSWER)
      return {
        blocked: 'Response blocked: the answer is too long to be checked by the guardrails',
      };
    const evaluated = this.#evaluate(this.#schema, text);
    return evaluated.blocked ? { blocked: evaluated.blocked.message } : {};
  }

  /** One text block of a held answer, through the chunk policies (redaction, secrets). */
  guardBlock(text: string): { text: string; blocked?: string } {
    if (this.#windowed.length === 0 || text === '') return { text };
    const evaluated = this.#evaluate(this.#windowed, text);
    return evaluated.blocked
      ? { text: '', blocked: evaluated.blocked.message }
      : { text: evaluated.text };
  }

  /** Hits of the whole stream so far (flag, redact and block), for logging. */
  get hits(): readonly GuardrailHit[] {
    return this.#hits;
  }

  /** Enabled policies of a type this gateway does not enforce. */
  get unknown(): readonly GuardrailPolicy[] {
    return [...this.#unknown.values()];
  }

  #evaluate(
    policies: readonly GuardrailPolicy[],
    text: string,
  ): { text: string; blocked?: { message: string } } {
    const fake: CanonicalResponse = {
      id: 'stream',
      model: 'stream',
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      created: 0,
    };
    const result = evaluateGuardrails(policies, {
      stage: 'response',
      response: fake,
      ...(this.#verdicts ? { external: this.#verdicts } : {}),
    });
    this.#record(result.hits, result.unknown);
    if (result.blocked) return { text: '', blocked: { message: result.blocked.message } };
    const part = fake.content[0];
    return { text: part?.type === 'text' ? part.text : text };
  }

  #record(hits: readonly GuardrailHit[], unknown: readonly GuardrailPolicy[]) {
    for (const hit of hits) {
      const same = this.#hits.find((h) => h.policyId === hit.policyId);
      if (same) same.matches += hit.matches;
      else this.#hits.push({ ...hit });
    }
    for (const policy of unknown) this.#unknown.set(policy.id, policy);
  }

  /** Index just after the last whitespace character, or 0 when the text has none. */
  static #lastBoundary(text: string, before = text.length): number {
    for (let i = before - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 10 || code === 9 || code === 13) return i + 1;
    }
    return 0;
  }

  #release(text: string): string {
    if (this.#schema.length > 0 && !this.#judged && this.#answer.length < MAX_HELD_ANSWER)
      this.#answer += text;
    return text;
  }

  push(delta: string): { text: string; blocked?: string } {
    if (!this.active) return { text: delta };
    this.#buffer += delta;
    if (this.#holdAll) {
      if (this.#buffer.length < MAX_HELD_ANSWER) return { text: '' };
      // Past the cap the answer cannot be judged as a whole: never release it unchecked.
      this.#buffer = '';
      return {
        text: '',
        blocked: 'Response blocked: the answer is too long to be checked by the guardrails',
      };
    }
    if (this.#windowed.length === 0) {
      const out = this.#buffer;
      this.#buffer = '';
      return { text: this.#release(out) };
    }
    // Only complete words are evaluated. The word still being received is kept raw: matching it
    // early would redact "user@example.co" and then leak the "m" that arrives in the next chunk.
    // A run with no whitespace at all (longer than four windows) is evaluated anyway to bound
    // memory and delay.
    let stableEnd = StreamGuardrailBuffer.#lastBoundary(this.#buffer);
    if (this.#buffer.length - stableEnd > this.#window * 4) stableEnd = this.#buffer.length;
    if (this.#holdKeys) {
      const key = pendingPrivateKeyStart(this.#buffer.slice(0, stableEnd));
      if (key >= 0 && this.#buffer.length - key < MAX_HELD_KEY)
        stableEnd = Math.min(stableEnd, key);
    }
    if (stableEnd === 0) return { text: '' };
    const evaluated = this.#evaluate(this.#windowed, this.#buffer.slice(0, stableEnd));
    if (evaluated.blocked) {
      this.#buffer = '';
      return { text: '', blocked: evaluated.blocked.message };
    }
    const tail = this.#buffer.slice(stableEnd);
    this.#buffer = evaluated.text + tail;
    const stable = evaluated.text.length;
    // Keep the last `window` characters of evaluated text so multi-word patterns that continue in
    // later chunks can still match, and release the rest up to a word boundary.
    if (stable <= this.#window) return { text: '' };
    const cut = StreamGuardrailBuffer.#lastBoundary(this.#buffer, stable - this.#window);
    if (cut === 0) return { text: '' };
    const out = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    return { text: this.#release(out) };
  }

  /**
   * The text and policies whose model calls must be made before `finish(final)`, when that call
   * gives the whole-answer verdict and some policy needs a model call; otherwise undefined.
   */
  pendingJudgement(
    final = false,
  ): { policies: readonly GuardrailPolicy[]; text: string } | undefined {
    if (!this.active || this.#external.length === 0 || this.#judged || this.#verdicts)
      return undefined;
    if (this.#holdAll)
      return this.#buffer === '' && !final
        ? undefined
        : { policies: this.#external, text: this.#buffer };
    // Text flows (flag): the verdict is recorded once, on the whole answer, at the end.
    return final ? { policies: this.#external, text: this.#answer + this.#buffer } : undefined;
  }

  /** Verdicts of the model calls asked for by `pendingJudgement()`. */
  setVerdicts(verdicts: ReadonlyMap<string, ExternalVerdict>): void {
    this.#verdicts = verdicts;
  }

  /**
   * Releases what is held: called before every non-text event (a closed block cannot take more
   * text) and with `final` at the end of the stream. The `json_schema` verdict is given once, on
   * the end of the stream (`final`), on the whole answer.
   */
  finish(final = false): { text: string; blocked?: string } {
    const rest = this.#buffer;
    this.#buffer = '';
    if (!this.active) return { text: rest };
    if (this.#holdAll) {
      if (rest === '' && !final) return { text: '' };
      // Everything was held: the whole answer is judged at once by every policy, then later text
      // (if any) flows through the windowed path.
      this.#holdAll = false;
      this.#judged = true;
      const evaluated = this.#evaluate(this.#policies, rest);
      if (evaluated.blocked) return { text: '', blocked: evaluated.blocked.message };
      return { text: evaluated.text };
    }
    let text = rest;
    if (rest !== '' && this.#windowed.length > 0) {
      const evaluated = this.#evaluate(this.#windowed, rest);
      if (evaluated.blocked) return { text: '', blocked: evaluated.blocked.message };
      text = evaluated.text;
    }
    this.#release(text);
    if (this.#schema.length > 0 && !this.#judged && final) {
      // Only `flag`/`redact` schema policies get here; the text has already been sent.
      this.#judged = true;
      this.#evaluate(this.#schema, this.#answer);
      this.#answer = '';
    }
    return { text };
  }

  /** Like `finish`, for callers that only need the text; blocked content is dropped. */
  flush(): string {
    return this.finish(true).text;
  }
}
