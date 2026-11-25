/** Request and answer shaping (sprint 5, epic 31) in both languages. */
export const shapingMessagesFa = {
  repair: {
    legend: 'ترمیم پاسخ و تاریخچه',
    json: 'ترمیم JSON خراب در پاسخ‌های response_format (فقط غیر stream)',
    tools: 'ترمیم tool callهای بی‌جفت یا تکراری در تاریخچه و آرگومان‌های خراب',
    hint: 'هدر x-dirouter-repair (json، tools، all یا off) این تنظیم را برای یک درخواست عوض می‌کند.',
  },
} as const;

export const shapingMessagesEn = {
  repair: {
    legend: 'Answer and history repair',
    json: 'Repair broken JSON in response_format answers (non-streamed only)',
    tools: 'Repair unpaired or duplicated tool calls in the history and broken arguments',
    hint: 'The x-dirouter-repair header (json, tools, all or off) overrides this for one request.',
  },
};
