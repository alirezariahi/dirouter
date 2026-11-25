/** Request and answer shaping (sprint 5, epic 31) in both languages. */
export const shapingMessagesFa = {
  repair: {
    legend: 'ترمیم پاسخ و تاریخچه',
    json: 'ترمیم JSON خراب در پاسخ‌های response_format (فقط غیر stream)',
    tools: 'ترمیم tool callهای بی‌جفت یا تکراری در تاریخچه و آرگومان‌های خراب',
    hint: 'هدر x-dirouter-repair (json، tools، all یا off) این تنظیم را برای یک درخواست عوض می‌کند.',
  },
  policy: {
    legend: 'شکل‌دهی درخواست',
    autoCache: 'breakpoint خودکار کش prompt (Anthropic و Bedrock)',
    autoCacheHint:
      'برای درخواستی که خودش cache_control ندارد روی ابزارها، system و آخرین پیام‌های پایدار breakpoint گذاشته می‌شود.',
    ttl: 'عمر کش',
    ttlDefault: 'پیش‌فرض provider',
  },
  promptCache: {
    title: 'کش prompt خود provider',
    detail:
      '{{read}} توکن خوانده‌شده از کش در {{requests}} درخواست ({{saved}} صرفه‌جویی)، {{write}} توکن نوشته‌شده ({{writeCost}} هزینهٔ اضافه)',
  },
} as const;

export const shapingMessagesEn = {
  repair: {
    legend: 'Answer and history repair',
    json: 'Repair broken JSON in response_format answers (non-streamed only)',
    tools: 'Repair unpaired or duplicated tool calls in the history and broken arguments',
    hint: 'The x-dirouter-repair header (json, tools, all or off) overrides this for one request.',
  },
  policy: {
    legend: 'Request shaping',
    autoCache: 'Automatic prompt-cache breakpoints (Anthropic and Bedrock)',
    autoCacheHint:
      'A request without its own cache_control gets breakpoints on the tools, the system prompt and the last stable messages.',
    ttl: 'Cache lifetime',
    ttlDefault: 'Provider default',
  },
  promptCache: {
    title: "Provider's prompt cache",
    detail:
      '{{read}} tokens read from the cache in {{requests}} requests ({{saved}} saved), {{write}} tokens written ({{writeCost}} extra)',
  },
};
