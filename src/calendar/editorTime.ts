import { DateTime } from 'luxon';
import type { EventInput } from '../shared/contracts';

/** Show every event in the app preference while retaining its source TZID. */
export function editorTime(value: string, input: Pick<EventInput, 'allDay' | 'timezone'>, displayZone: string) {
  return input.allDay ? value.slice(0, 10) : DateTime.fromISO(value, { zone: input.timezone }).setZone(displayZone).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** ICS serialization expects civil time in the source zone, not a re-tagged UTC instant. */
export function sourceTime(value: string, input: Pick<EventInput, 'allDay' | 'timezone'>, displayZone: string) {
  if (input.allDay || !value) return value;
  const date = DateTime.fromISO(value, { zone: displayZone });
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16)) throw new Error('该时间无效或因夏令时切换而不存在，请选择其他时间');
  return date.setZone(input.timezone).toISO()!;
}

export function changedEventTime(input: EventInput, key: 'start' | 'end', value: string, displayZone: string): EventInput {
  const converted = sourceTime(value,input,displayZone);
  if (key === 'end') return { ...input,end:converted };
  if (input.allDay) {
    const days = Math.max(1,DateTime.fromISO(input.end).diff(DateTime.fromISO(input.start),'days').days);
    return { ...input,start:converted,end:DateTime.fromISO(converted).plus({days}).toISODate()! };
  }
  return { ...input,start:converted,end:DateTime.fromISO(converted,{setZone:true}).plus({hours:1}).setZone(input.timezone).toISO()! };
}
