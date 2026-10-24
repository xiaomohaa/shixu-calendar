import { describe, expect, it } from 'vitest';
import { holidayCalendarIds } from '../src/calendar/eventMarker';
import type { Account, Calendar } from '../src/shared/contracts';

const calendar = (id: string, accountId: string, name: string): Calendar => ({ id, accountId, name, url: '', color: '#aa66cc', visible: true, readOnly: false });
const account = (id: string, name: string, url: string, subscription = false): Account => ({ id, name, url, username: '', allowHttp: false, paused: false, lastSync: null, error: null, subscription });
describe('全天日程的来源图标', () => {
  it('按节假日订阅 URL 和日历名称识别，不把普通工作日历误标', () => {
    const calendars = [calendar('work','dav','工作'), calendar('holiday','apple','日历'), calendar('cn','feed','中国大陆节假日'), calendar('english','dav','UK Holidays')];
    const accounts = [account('dav','工作','https://dav.example.com/'), account('apple','日历','https://calendars.icloud.com/holidays/cn_zh.ics/',true), account('feed','订阅','https://example.com/feed.ics',true)];
    expect([...holidayCalendarIds(calendars, accounts)]).toEqual(['holiday','cn','english']);
  });
  it('普通账户名称和 URL 中的 holiday 单词不会把所有日历变成节假日', () => {
    const calendars = [calendar('personal','a','个人'), calendar('trip','a','旅行计划')];
    expect(holidayCalendarIds(calendars, [account('a','Holiday trip','https://holiday.example.com/dav/')]).size).toBe(0);
  });
});
