/** Drive the actual separate date picker and time field used by the event editor. */
export async function setEditorDateTime(page, label, value) {
  const [date, time] = value.split('T');
  const trigger = page.getByRole('button', { name: `${label}日期`, exact: true });
  if (await trigger.getAttribute('data-date') !== date) {
    await trigger.click();
    const picker = page.locator('.event-date-picker'); await picker.waitFor();
    const month = await picker.getAttribute('data-month');
    const difference = (Number(date.slice(0, 4)) - Number(month.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(month.slice(5, 7));
    for (let i = 0; i < Math.abs(difference); i++) {
      const before = await picker.getAttribute('data-month');
      await picker.getByRole('button', { name: difference > 0 ? '日期选择下个月' : '日期选择上个月', exact: true }).click();
      await page.waitForFunction(before => document.querySelector('.event-date-picker')?.dataset.month !== before, before);
    }
    await picker.getByRole('button', { name: `选择 ${date}`, exact: true }).click();
    await picker.waitFor({ state: 'detached' });
  }
  if (time) await page.getByLabel(`${label}时间`, { exact: true }).fill(time.slice(0, 5));
}

export async function editorDateTime(page, label) {
  const day = await page.getByRole('button', { name: `${label}日期`, exact: true }).getAttribute('data-date');
  const clock = page.getByLabel(`${label}时间`, { exact: true });
  return day + (await clock.count() ? `T${await clock.inputValue()}` : '');
}
