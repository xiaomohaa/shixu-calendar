import type { Resource } from '../database/store';
import type { CalendarEvent } from '../shared/contracts';

interface Input { resources: Resource[]; visibleCalendars: string[]; conflictResources: string[]; start: string; end: string; timezone: string }
interface Output { events: CalendarEvent[]; diagnostics: string[] }
type Response = { id: number; ok: true } & Output | { id: number; ok: false; error: string };

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: Output): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();

function reset(error: Error) {
  worker?.terminate(); worker = undefined;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
  pending.clear();
}

export function expandInWorker(input: Input): Promise<Output> {
  if (!worker) {
    worker = new Worker(new URL('../workers/ics.ts', import.meta.url), { type: 'module' });
    worker.onerror = () => reset(new Error('日程解析进程已中断，请重试'));
    worker.onmessageerror = () => reset(new Error('日程解析结果无法读取，请重试'));
    worker.onmessage = (message: MessageEvent<Response>) => {
      const result = message.data, task = pending.get(result.id);
      if (!task) return;
      pending.delete(result.id); clearTimeout(task.timer);
      if (result.ok) task.resolve({ events: result.events, diagnostics: result.diagnostics });
      else task.reject(new Error(result.error));
    };
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reset(new Error('日程解析超时，请缩小查询范围后重试')), 30000);
    pending.set(id, { resolve, reject, timer });
    try { worker!.postMessage({ id, ...input }); }
    catch { reset(new Error('无法提交日程解析任务，请重试')); }
  });
}
