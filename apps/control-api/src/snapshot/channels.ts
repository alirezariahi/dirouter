/** کانال‌های Valkey برای انتشار snapshot (بدون وابستگی به Nest تا اسکریپت‌ها هم import کنند). */
export const CONFIG_CHANNEL = 'dirouter:config:updated';
/** درخواست ساخت دوباره از بیرون از API (مثلاً seed یا ابزار مدیریتی). */
export const REBUILD_CHANNEL = 'dirouter:config:rebuild';
