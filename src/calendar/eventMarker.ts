import type { Account, Calendar } from '../shared/contracts';

/** Use the calendar's identity, never an ordinary event's title, to mark holidays. */
export function holidayCalendarIds(calendars: Calendar[], accounts: Account[]) {
  return new Set(calendars.filter(calendar => {
    const account = accounts.find(item => item.id === calendar.accountId);
    if (/(?:节假日|节日日历|公共假期|法定假日|holidays?)/i.test(calendar.name)) return true;
    if (!account?.subscription) return false;
    if (/(?:节假日|节日日历|公共假期|法定假日|holidays?)/i.test(account.name)) return true;
    try { return /(?:^|\/)holidays?(?:\/|$)/i.test(new URL(account.url).pathname); } catch { return false; }
  }).map(calendar => calendar.id));
}
