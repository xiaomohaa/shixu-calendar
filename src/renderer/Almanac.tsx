import { getChineseCalendarDay } from '../calendar/chineseCalendar';
import { describeHoliday, hasHolidaySchedule } from '../calendar/chinaHolidays';

const dateLabel = (date: string) => date.slice(5).replace('-', '月') + '日';
export function Almanac({ date }: { date: string }) {
  const day = getChineseCalendarDay(date);
  return <section className="almanac" aria-label="所选日期农历与黄历" data-date={date}>
    {day ? <>
      <div className="lunar-heading"><strong>农历{day.lunarDate}</strong>{day.solarTerm && <span className="solar-term-tag">{day.solarTerm}</span>}</div>
      <div className="ganzhi-line">{day.yearGanZhi}{day.zodiac}年 · {day.monthGanZhi}月 · {day.dayGanZhi}日</div>
      {day.festivals.length > 0 && <div className="festival-line">{day.festivals.join(' · ')}</div>}
      <div className={`holiday-line ${day.holiday?.kind ?? ''}`}>
        {day.holiday && <span className={`day-status ${day.holiday.kind}`}>{day.holiday.kind === 'rest' ? '休' : '班'}</span>}
        <span>{describeHoliday(date)}</span>
      </div>
      <div className="almanac-preview" aria-label="黄历宜忌">
        <div className="almanac-row yi"><b>宜</b><span title={day.yi.join('、')}>{day.yi.slice(0, 4).join(' · ') || '无'}{day.yi.length > 4 ? '…' : ''}</span></div>
        <div className="almanac-row ji"><b>忌</b><span title={day.ji.join('、')}>{day.ji.slice(0, 4).join(' · ') || '无'}{day.ji.length > 4 ? '…' : ''}</span></div>
      </div>
      <details className="almanac-details"><summary>完整黄历与假期安排</summary>
        <dl><dt>农历</dt><dd>{day.lunarYear}年{day.lunarDate}</dd><dt>宜</dt><dd>{day.yi.join('、') || '无'}</dd><dt>忌</dt><dd>{day.ji.join('、') || '无'}</dd><dt>冲煞</dt><dd>{day.chongSha}</dd><dt>值神</dt><dd>{day.god} · {day.godLuck}</dd><dt>方位</dt><dd>财神{day.wealthDirection} · 喜神{day.joyDirection}</dd><dt>彭祖百忌</dt><dd>{day.pengZu}</dd></dl>
        {day.holiday && <div className="holiday-schedule"><strong>{day.holiday.name}安排</strong><p>{dateLabel(day.holiday.schedule.start)}至{dateLabel(day.holiday.schedule.end)}放假</p><p>{day.holiday.schedule.workdays.length ? `${day.holiday.schedule.workdays.map(dateLabel).join('、')}调休上班` : '无额外补班'}</p></div>}
        <small>中国大陆放假调休已收录2024–2026年，依据国务院办公厅通知。{!hasHolidaySchedule(Number(date.slice(0, 4))) ? '当前年份不推算调休日。' : ''}节气按北京时间历日显示，黄历为传统民俗信息。</small>
      </details>
    </> : <div className="ganzhi-line">农历与黄历支持1901–2099年</div>}
  </section>;
}
