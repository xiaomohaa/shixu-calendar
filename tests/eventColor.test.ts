import { expect, it } from 'vitest';
import { onEventColor } from '../src/calendar/eventColor';

it('选中时间块按日历颜色选择可读文字', () => {
  expect(onEventColor('#ffe66d')).toBe('#171717');
  expect(onEventColor('#fafafa')).toBe('#171717');
  expect(onEventColor('#7000b8')).toBe('#fdfcfb');
  expect(onEventColor('#183552')).toBe('#fdfcfb');
  expect(onEventColor('invalid')).toBe(onEventColor('#497bba'));
});
