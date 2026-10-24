import { getChineseCalendarDay } from '../calendar/chineseCalendar';

export function Almanac({ date }: { date: string }) {
  const day = getChineseCalendarDay(date);
  return <section className="almanac" aria-label="所选日期农历与黄历" data-date={date}>
    {day ? <>
      <div className="lunar-heading"><strong>农历{day.lunarDate}</strong>{day.solarTerm && <span className="solar-term-tag">{day.solarTerm}</span>}</div>
      <div className="ganzhi-line">{day.yearGanZhi}{day.zodiac}年 · {day.monthGanZhi}月 · {day.dayGanZhi}日</div>
      <div className="almanac-preview" aria-label="黄历宜忌">
        <div className="almanac-row yi"><b>宜</b><span title={day.yi.join('、')}>{day.yi.slice(0, 4).join(' · ') || '无'}{day.yi.length > 4 ? '…' : ''}</span></div>
        <div className="almanac-row ji"><b>忌</b><span title={day.ji.join('、')}>{day.ji.slice(0, 4).join(' · ') || '无'}{day.ji.length > 4 ? '…' : ''}</span></div>
      </div>
      <details className="almanac-details"><summary>完整黄历</summary>
        <dl><dt>农历</dt><dd>{day.lunarYear}年{day.lunarDate}</dd><dt>宜</dt><dd>{day.yi.join('、') || '无'}</dd><dt>忌</dt><dd>{day.ji.join('、') || '无'}</dd><dt>冲煞</dt><dd>{day.chongSha}</dd><dt>值神</dt><dd>{day.god} · {day.godLuck}</dd><dt>方位</dt><dd>财神{day.wealthDirection} · 喜神{day.joyDirection}</dd><dt>彭祖百忌</dt><dd>{day.pengZu}</dd></dl>
        <small>节气按北京时间历日显示，黄历为传统民俗信息。节假日与调休安排由导入的日历提供。</small>
      </details>
    </> : <div className="ganzhi-line">农历与黄历支持1901–2099年</div>}
  </section>;
}
