export interface ReminderEvent {
  resourceId: string;
  recurrenceId?: string;
  start: string;
  allDay: boolean;
}

export interface ReminderNotice {
  key: string;
  title: string;
  body: string;
  event?: ReminderEvent;
  theme: 'system' | 'light' | 'dark';
  test: boolean;
  lifetimeMs: number;
}
