export const RELEASE_PAGE = 'https://github.com/xiaomohaa/shixu-calendar/releases/latest';
export type AppMode = 'installer' | 'portable' | 'unpacked' | 'development';
export interface UpdateProgress { percent: number; transferred: number; total: number; bytesPerSecond: number }
export interface UpdateRelease { version: string; notes: string; date: string | null }
export interface UpdateState {
  currentVersion: string; mode: AppMode;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  release: UpdateRelease | null; progress: UpdateProgress | null; lastChecked: string | null; error: string | null;
}
export interface DesktopState { mode: AppMode; openAtLogin: boolean; startupEnabled: boolean; canAutoStart: boolean }
