/**
 * Request-level routing in the dashboard (sprint 5, cards 32.1, 32.5, 31.5 and 32.7): the
 * simulator's provider preferences and the reasons they remove a target.
 */
import type { Widen } from './s2/types';

export const routingRequestsFa = {
  preferences: 'ترجیح ارائه‌دهنده (JSON، اختیاری)',
  preferencesHint:
    'همان شیء provider در بدنهٔ درخواست، مثلاً {"order":["openai"],"sort":"price","max_price":{"prompt":1}}',
  fallbackModels: 'مدل‌های جایگزین (اختیاری، با ویرگول)',
  invalidJson: 'ترجیح ارائه‌دهنده باید یک شیء JSON معتبر باشد.',
  models: 'مدل‌ها به ترتیب',
  applied: 'ترجیح اعمال‌شده',
  locked: 'سیاست این کلید قفل است؛ ترجیح ارسالی مشتری نادیده گرفته شد.',
  lockedPolicy: 'ترجیح ارائه‌دهنده با سیاست مدیر قفل شده است.',
  throughput: 'سرعت تولید',
  tps: 'توکن در ثانیه',
  reason: {
    provider_not_in_only: 'در فهرست only نیست',
    provider_ignored: 'در فهرست ignore است',
    above_max_price_prompt: 'قیمت ورودی از max_price بیشتر است',
    above_max_price_completion: 'قیمت خروجی از max_price بیشتر است',
    above_max_price_request: 'قیمت هر درخواست از max_price بیشتر است',
    above_max_price_image: 'قیمت هر تصویر از max_price بیشتر است',
    fallbacks_not_allowed: 'فال‌بک مجاز نیست (allow_fallbacks: false)',
    fallback_model_not_found: 'مدل جایگزین پیدا نشد',
    fallback_model_not_allowed: 'این کلید به مدل جایگزین دسترسی ندارد',
    fallback_no_available_provider: 'مدل جایگزین ارائه‌دهندهٔ در دسترس ندارد',
    fallback_context_length_exceeded: 'درخواست در پنجرهٔ زمینهٔ مدل جایگزین جا نمی‌شود',
  },
  error: {
    no_provider_matches_preferences: 'هیچ ارائه‌دهنده‌ای با ترجیح‌های این درخواست جور نیست.',
  },
} as const;

export const routingRequestsEn: Widen<typeof routingRequestsFa> = {
  preferences: 'Provider preferences (JSON, optional)',
  preferencesHint:
    'The request\'s provider object, e.g. {"order":["openai"],"sort":"price","max_price":{"prompt":1}}',
  fallbackModels: 'Fallback models (optional, comma separated)',
  invalidJson: 'Provider preferences must be a valid JSON object.',
  models: 'Models in order',
  applied: 'Preferences applied',
  locked: "This key's policy is locked; the client's preferences were ignored.",
  lockedPolicy: "Provider preferences are locked by the administrator's policy.",
  throughput: 'Generation speed',
  tps: 'tokens/s',
  reason: {
    provider_not_in_only: 'Not in the only list',
    provider_ignored: 'In the ignore list',
    above_max_price_prompt: 'Input price above max_price',
    above_max_price_completion: 'Output price above max_price',
    above_max_price_request: 'Request price above max_price',
    above_max_price_image: 'Image price above max_price',
    fallbacks_not_allowed: 'Fallbacks not allowed (allow_fallbacks: false)',
    fallback_model_not_found: 'Fallback model not found',
    fallback_model_not_allowed: 'This key may not use the fallback model',
    fallback_no_available_provider: 'Fallback model has no available provider',
    fallback_context_length_exceeded: 'Request does not fit the fallback model context window',
  },
  error: {
    no_provider_matches_preferences: "No provider matches this request's preferences.",
  },
};
