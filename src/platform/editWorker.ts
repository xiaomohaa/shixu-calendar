import type { EventInput } from '../shared/contracts';
import type { Resource } from '../database/store';

type Job =
  | { kind: 'edit'; input: EventInput; original?: string }
  | { kind: 'detail'; resource: Resource; scope: 'series' | 'instance'; recurrenceId?: string; timezone: string }
  | { kind: 'exclude' | 'deleteFuture'; ics: string; recurrenceId: string }
  | { kind: 'copy'; ics: string };
type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

function reset(error: Error) {
  worker?.terminate(); worker = undefined;
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
  pending.clear();
}

export function editInWorker<T>(job: Job): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('../workers/edit.ts', import.meta.url), { type: 'module' });
    worker.onerror = () => reset(new Error('日程编辑进程已中断，请重试'));
    worker.onmessageerror = () => reset(new Error('无法读取日程编辑结果'));
    worker.onmessage = (message: MessageEvent<Response>) => {
      const result = message.data, task = pending.get(result.id);
      if (!task) return;
      clearTimeout(task.timer); pending.delete(result.id);
      if (result.ok) task.resolve(result.value);
      else task.reject(new Error(result.error));
    };
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reset(new Error('日程处理超时，请重试')), 30000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try { worker!.postMessage({ id, ...job }); }
    catch { reset(new Error('无法提交日程编辑任务')); }
  });
}
