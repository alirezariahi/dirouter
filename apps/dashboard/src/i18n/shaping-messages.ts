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
    defaults: 'مقدار پیش‌فرض پارامترها (JSON)',
    overrides: 'مقدار اجباری پارامترها (JSON)',
    drop: 'پارامترهای همیشه حذف‌شونده',
    unsupported: 'پارامترهای پشتیبانی‌نشده (حذف یا 400 بنا بر drop_params)',
    paramsHint:
      'نام‌های temperature، top_p، top_k، max_tokens، seed، stop، reasoning_effort و parallel_tool_calls در هر فرمتی کار می‌کنند؛ هر نام دیگر فیلد بدنهٔ خود provider است (با نقطه برای فیلد تودرتو).',
    invalidJson: 'یک شیء JSON معتبر وارد کنید.',
  },
  dropParams: {
    label: 'حذف پارامترهای پشتیبانی‌نشده (drop_params)',
    hint: 'خاموش باشد، درخواستی که پارامتری دارد که مدل مقصد نمی‌پذیرد با خطای 400 و نام پارامتر رد می‌شود. هدر x-dirouter-drop-params یا فیلد drop_params درخواست آن را برای همان درخواست عوض می‌کند.',
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
    defaults: 'Parameter defaults (JSON)',
    overrides: 'Forced parameter values (JSON)',
    drop: 'Parameters always removed',
    unsupported: 'Unsupported parameters (dropped or a 400, by drop_params)',
    paramsHint:
      "temperature, top_p, top_k, max_tokens, seed, stop, reasoning_effort and parallel_tool_calls work in every format; any other name is a field of the provider's own body (dotted for nested fields).",
    invalidJson: 'Enter a valid JSON object.',
  },
  dropParams: {
    label: 'Drop unsupported parameters (drop_params)',
    hint: "When off, a request with a parameter the target model does not take is refused with a 400 that names it. The x-dirouter-drop-params header or the request's drop_params field overrides it for that request.",
  },
  promptCache: {
    title: "Provider's prompt cache",
    detail:
      '{{read}} tokens read from the cache in {{requests}} requests ({{saved}} saved), {{write}} tokens written ({{writeCost}} extra)',
  },
};
