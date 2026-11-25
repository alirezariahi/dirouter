/** Live view connection state copy (card 24.4), kept apart from shared locales. */
export const liveMessages = {
  en: {
    stream: 'Live: new requests appear as they finish',
    polling: 'Live stream unavailable: refreshing every second',
    connecting: 'Connecting to the live stream…',
    paused: 'Paused',
  },
  fa: {
    stream: 'زنده: درخواست‌های جدید همان لحظهٔ پایان نمایش داده می‌شوند',
    polling: 'جریان زنده در دسترس نیست: نوسازی هر ثانیه',
    connecting: 'در حال اتصال به جریان زنده…',
    paused: 'متوقف',
  },
} as const;
