import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const result = await page.evaluate(async () => {
    const { expandInWorker } = await import('/src/platform/icsWorker.ts');
    return expandInWorker({
      resources: [{ id: 'r', calendarId: 'c', url: 'https://example.test/r.ics', etag: '"v1"', dirty: 1, deleted: 0,
        ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:worker-test\r\nDTSTART:20261023T100000Z\r\nDTEND:20261023T110000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Worker test\r\nEND:VEVENT\r\nEND:VCALENDAR' }],
      visibleCalendars: ['c'], conflictResources: [],
      start: '2026-10-23T00:00:00Z', end: '2026-10-26T00:00:00Z', timezone: 'Asia/Shanghai',
    });
  });
  if (result.events.length !== 2 || result.events.some(event => !event.pending) || result.diagnostics.length) {
    throw new Error(`Worker ICS regression: ${JSON.stringify(result)}`);
  }
  console.log('PASS: Edge module Worker expanded recurring ICS and kept pending state');
} finally {
  await browser?.close();
  await server.close();
}
