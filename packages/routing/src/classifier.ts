/**
 * Rule-based request classifier (card 20.4): what kind of task a request is (coding, reasoning,
 * summarization or chat), how big it is, and whether it needs tools, images or a long context.
 * It reads only the system prompt and the last user message, capped in length, with precompiled
 * patterns, so a decision costs microseconds (the criterion is under 2 ms).
 */
import type { CanonicalRequest } from '@dirouter/contracts';

export type TaskType = 'coding' | 'reasoning' | 'summarization' | 'chat';
export type RequestSize = 'small' | 'medium' | 'large';

export interface Classification {
  taskType: TaskType;
  size: RequestSize;
  /** `documents` and `audio`: PDF/file and audio input (card 27.2). */
  needs: {
    tools: boolean;
    vision: boolean;
    longContext: boolean;
    documents: boolean;
    audio: boolean;
  };
  /** 0..1: how clearly the rules matched; low values can be handed to a small model. */
  confidence: number;
  /** Human-readable signals that led to the decision (logged with the request). */
  reasons: string[];
}

/** Text beyond this is not inspected; the head and tail of a message carry the intent. */
const MAX_SCAN = 6_000;
const LONG_CONTEXT_TOKENS = 32_000;

interface Rule {
  type: Exclude<TaskType, 'chat'>;
  reason: string;
  weight: number;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { type: 'coding', reason: 'code block', weight: 3, pattern: /```/ },
  {
    type: 'coding',
    reason: 'stack trace or compiler error',
    weight: 3,
    pattern:
      /\b(Traceback \(most recent call last\)|TypeError:|SyntaxError:|NullPointerException|at [\w.$]+\([\w.]+:\d+\)|error TS\d{4}|panic:|segmentation fault)/,
  },
  {
    type: 'coding',
    reason: 'source code',
    weight: 2,
    pattern:
      /\b(function\s+\w+\s*\(|def \w+\(|class \w+[\s({:]|import \w+|from \w+ import|const \w+ = |=>|public static|#include|SELECT .+ FROM|async fn|func \w+\()/,
  },
  {
    type: 'coding',
    reason: 'programming request',
    weight: 2,
    pattern:
      /\b(refactor|debug|unit tests?|regex|compile|implement|bug|repository|pull request|typescript|javascript|python|golang|rust|java|kotlin|sql|dockerfile|kubernetes|api endpoint)\b|\.(ts|tsx|js|py|go|rs|java|rb|php|cs|cpp|sh|yaml|json)\b|(کد|برنامه[‌ ]?نویسی|باگ|دیباگ|تابع|کلاس|ریفکتور|تست واحد)/i,
  },
  {
    type: 'summarization',
    reason: 'summary requested',
    weight: 3,
    pattern:
      /\b(summari[sz]e|summary|tl;?dr|key points|in (a few|three|3) (sentences|bullets)|condense|outline the main)\b|(خلاصه|چکیده|نکات اصلی|جمع[‌ ]?بندی)/i,
  },
  {
    type: 'reasoning',
    reason: 'reasoning requested',
    weight: 2,
    pattern:
      /\b(step[- ]by[- ]step|prove|proof|derive|why does|explain why|reason(ing)? about|analy[sz]e|trade-?offs?|compare and contrast|plan (a|the)|riddle|puzzle|calculate|solve)\b|(گام به گام|اثبات|استدلال|تحلیل|چرا|مقایسه کن|حل کن|محاسبه)/i,
  },
  {
    type: 'reasoning',
    reason: 'mathematics',
    weight: 2,
    pattern:
      /(\\frac|\\sum|\\int|∑|∫|√|\b\d+\s*[*/^]\s*\d+\s*[=+-]|\b(integral|derivative|equation|theorem|probability|matrix)\b|(معادله|انتگرال|مشتق|احتمال|ماتریس))/i,
  },
];

type Parts = CanonicalRequest['messages'][number]['content'];

function textOf(content: Parts | CanonicalRequest['system']): string {
  let out = '';
  for (const part of content) if (part.type === 'text') out += `${part.text}\n`;
  return out;
}

const hasImage = (content: Parts) => content.some((part) => part.type === 'image');

/** Head and tail of long text: instructions usually open or close a message. */
function scan(text: string): string {
  return text.length <= MAX_SCAN
    ? text
    : `${text.slice(0, MAX_SCAN / 2)}\n${text.slice(-MAX_SCAN / 2)}`;
}

export function classifyRequest(
  request: Pick<CanonicalRequest, 'messages' | 'tools' | 'maxOutputTokens' | 'system'>,
  estimatedInputTokens: number,
): Classification {
  const reasons: string[] = [];
  let lastUser = '';
  let vision = false;
  let documents = false;
  let audio = false;
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (!m) continue;
    if (hasImage(m.content)) vision = true;
    if (m.content.some((part) => part.type === 'document')) documents = true;
    if (m.content.some((part) => part.type === 'audio')) audio = true;
    if (m.role === 'user' && !lastUser) lastUser = textOf(m.content);
  }
  const system = textOf(request.system);
  const text = scan(`${system.slice(0, 1_000)}\n${lastUser}`);

  const scores = { coding: 0, reasoning: 0, summarization: 0 };
  for (const rule of RULES)
    if (rule.pattern.test(text)) {
      scores[rule.type] += rule.weight;
      reasons.push(rule.reason);
    }
  const tools = (request.tools?.length ?? 0) > 0;
  if (tools) {
    // Agents with tools are mostly coding agents (Claude Code, Codex, OpenCode).
    scores.coding += 1;
    reasons.push('tools offered');
  }
  const ranked = (Object.entries(scores) as [Exclude<TaskType, 'chat'>, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const [best, bestScore] = ranked[0] ?? ['reasoning', 0];
  const second = ranked[1]?.[1] ?? 0;
  const taskType: TaskType = bestScore >= 2 ? best : 'chat';
  if (taskType === 'chat') reasons.push('no strong signal: general chat');
  const confidence =
    taskType === 'chat'
      ? bestScore === 0
        ? 0.6
        : 0.3
      : Math.min(1, (bestScore - second) / 4 + 0.4);

  const total = estimatedInputTokens + (request.maxOutputTokens ?? 0);
  const size: RequestSize = total > 16_000 ? 'large' : total > 2_000 ? 'medium' : 'small';
  const longContext = total > LONG_CONTEXT_TOKENS;
  if (vision) reasons.push('image input');
  if (documents) reasons.push('document input');
  if (audio) reasons.push('audio input');
  if (longContext) reasons.push(`long context (~${String(total)} tokens)`);
  return {
    taskType,
    size,
    needs: { tools, vision, longContext, documents, audio },
    confidence,
    reasons,
  };
}

// V8 compiles each pattern on first use and the JIT warms the function up; doing that once at load
// keeps it out of the first real request's latency.
for (let i = 0; i < 50; i++)
  classifyRequest(
    {
      system: [{ type: 'text', text: 'warm-up' }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Summarize, prove step by step and debug ```x```' }],
        },
      ],
      tools: [],
    },
    0,
  );
