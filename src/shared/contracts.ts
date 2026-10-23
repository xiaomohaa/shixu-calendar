import { z } from 'zod';

export const accountInput = z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048), username: z.string().min(1).max(500),
  password: z.string().max(4096).optional(), allowHttp: z.boolean().default(false),
  paused: z.boolean().default(false),
});
export type AccountInput = z.infer<typeof accountInput>;
export interface Account extends Omit<AccountInput, 'password' | 'id'> { id: string; lastSync: string | null; error: string | null }
export interface Calendar { id: string; accountId: string; url: string; name: string; color: string; visible: boolean; readOnly: boolean }
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']), view: z.enum(['dayGridMonth', 'timeGridWeek', 'timeGridDay', 'listMonth']),
  firstDay: z.number().int().min(0).max(6), duration: z.number().int().min(5).max(1440),
  reminder: z.number().int().min(-1).max(10080), timezone: z.string().min(1).max(100),
  autoSync: z.boolean(), interval: z.number().int().min(1).max(1440),
  defaultCalendar: z.string(), timeFormat: z.enum(['24', '12']), dateFormat: z.enum(['numeric', 'chinese']),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = { theme: 'system', view: 'dayGridMonth', firstDay: 1, duration: 60, reminder: 15, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, autoSync: true, interval: 10, defaultCalendar: '', timeFormat: '24', dateFormat: 'chinese' };
export const eventInput = z.object({
  resourceId: z.string().optional(), calendarId: z.string().min(1), uid: z.string().optional(),
  title: z.string().trim().min(1, '请输入日程标题').max(500), start: z.string().min(10), end: z.string().min(10),
  allDay: z.boolean(), timezone: z.string().min(1).max(100), location: z.string().max(2000), description: z.string().max(50000),
  floating: z.boolean().optional(),
  rrule: z.string().max(2000), reminder: z.number().int().min(-2).max(10080),
  scope: z.enum(['series', 'instance']).default('series'), recurrenceId: z.string().optional(),
});
export type EventInput = z.infer<typeof eventInput>;
export interface CalendarEvent { id: string; resourceId: string; calendarId: string; uid: string; title: string; start: string; end: string; allDay: boolean; timezone: string; location: string; description: string; rrule: string; reminder: number; recurrenceId?: string; recurring: boolean; pending: boolean; conflict: boolean; warning?: string }
export interface Conflict { id: string; resourceId: string; localIcs: string; remoteIcs: string | null; remoteEtag: string | null; createdAt: string }
export interface Snapshot { accounts: Account[]; calendars: Calendar[]; settings: Settings; pending: number; conflicts: Conflict[]; syncing: string[]; bytes: number; resources: number; diagnostics: string[] }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Api {
  snapshot(): Promise<Snapshot>;
  events(start: string, end: string): Promise<CalendarEvent[]>;
  eventDetail(resourceId: string, scope: 'series' | 'instance', recurrenceId?: string): Promise<EventInput>;
  testAccount(input: AccountInput): Promise<Calendar[]>;
  saveAccount(input: AccountInput): Promise<string>;
  deleteAccount(id: string): Promise<void>;
  sync(id?: string): Promise<void>;
  cancelSync(): Promise<void>;
  saveEvent(input: EventInput): Promise<void>;
  deleteEvent(resourceId: string, scope: 'series' | 'instance', recurrenceId?: string): Promise<void>;
  setCalendar(id: string, visible: boolean, color: string): Promise<void>;
  settings(input: Settings): Promise<void>;
  resolveConflict(id: string, choice: 'local' | 'remote' | 'both'): Promise<void>;
  clearCache(): Promise<void>;
  backup(): Promise<boolean>;
  restore(): Promise<boolean>;
  onChange(callback: () => void): () => void;
}
declare global { interface Window { shixu: Api } }
