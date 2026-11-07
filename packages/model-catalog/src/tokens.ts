/**
 * تخمین توکن وقتی provider usage برنمی‌گرداند (کارت ۶.۲) و برای فیلتر context
 * window در router. encoder یک بار و lazy بارگذاری می‌شود (o200k_base؛ برای مدل‌های
 * غیر OpenAI تقریبی است و رویداد با `usageEstimated=true` علامت می‌خورد).
 */
import type { CanonicalPart, CanonicalRequest } from '@dirouter/contracts';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | undefined;
const enc = () => (encoder ??= new Tiktoken(o200k));

/** هزینهٔ تقریبی هر تصویر (معادل detail=low در OpenAI). */
const IMAGE_TOKENS = 85;
/** سربار هر پیام (نقش و جداکننده‌ها). */
const MESSAGE_OVERHEAD = 4;

export function countTokens(text: string): number {
  if (text === '') return 0;
  return enc().encode(text).length;
}

/** تخمین ارزان بدون tokenizer (برای مسیر داغ): ~۴ کاراکتر لاتین یا ~۲ کاراکتر غیرلاتین در هر توکن. */
export function roughTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) / 2);
}

function partText(part: CanonicalPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'tool_call':
      return `${part.name} ${part.arguments}`;
    case 'tool_result':
      return part.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    case 'reasoning':
      return part.text;
    case 'image':
      return '';
  }
}

export function estimateRequestTokens(
  req: CanonicalRequest,
  count: (text: string) => number = countTokens,
): number {
  let total = req.system.reduce((n, p) => n + count(p.text), 0);
  for (const message of req.messages) {
    total += MESSAGE_OVERHEAD;
    for (const part of message.content)
      total += part.type === 'image' ? IMAGE_TOKENS : count(partText(part));
  }
  for (const tool of req.tools ?? [])
    total += count(`${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.parameters)}`);
  return total;
}
