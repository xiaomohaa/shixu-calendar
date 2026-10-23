import type { AppMode, UpdateProgress, UpdateRelease, UpdateState } from '../shared/updates';

export interface UpdateDriver {
  check(): Promise<UpdateRelease | null>;
  download(progress: (value: UpdateProgress) => void): Promise<void>;
  cancel(): void;
  install(): void;
}

export function updateError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/sha512|checksum|digest|signature|ERR_UPDATER_INVALID/i.test(message)) return '更新文件校验失败，未安装。请重新下载或从发布页面获取安装包。';
  if (/404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(message)) return '发布页面暂未提供可用的更新元数据，请稍后重试或查看发布页面。';
  if (/certificate|CERT_|TLS/i.test(message)) return '更新连接的证书验证失败，请检查系统时间与网络。';
  return '更新操作失败，请检查网络后重试，也可从发布页面手动下载。';
}

/** Only a resolved (integrity-verified) driver download can unlock installation. */
export class UpdateController {
  private value: UpdateState;
  private operation: Promise<void> | null = null;
  private cancelled = false;
  constructor(version: string, mode: AppMode, private driver: UpdateDriver, private changed: (state: UpdateState) => void, private prepare: () => Promise<void>) {
    this.value = { currentVersion: version, mode, phase: 'idle', release: null, progress: null, lastChecked: null, error: null };
  }
  state(): UpdateState { return structuredClone(this.value); }
  private set(patch: Partial<UpdateState>) { Object.assign(this.value, patch); this.changed(this.state()); }
  check(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.value.mode === 'development' || ['downloaded', 'installing'].includes(this.value.phase)) return Promise.resolve();
    this.set({ phase: 'checking', error: null, progress: null });
    this.operation = (async () => {
      try { const release = await this.driver.check(); this.set({ phase: release ? 'available' : 'current', release, lastChecked: new Date().toISOString() }); }
      catch (error) { this.set({ phase: 'error', error: updateError(error) }); }
    })().finally(() => { this.operation = null; });
    return this.operation;
  }
  download(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.value.mode !== 'installer' || !this.value.release || !['available', 'error'].includes(this.value.phase)) return Promise.resolve();
    this.cancelled = false;
    this.set({ phase: 'downloading', error: null, progress: null });
    this.operation = (async () => {
      try {
        await this.driver.download(progress => { if (!this.cancelled) this.set({ progress }); });
        this.set({ phase: this.cancelled ? 'available' : 'downloaded', progress: null });
      } catch (error) { this.set({ phase: this.cancelled ? 'available' : 'error', error: this.cancelled ? null : updateError(error), progress: null }); }
    })().finally(() => { this.operation = null; });
    return this.operation;
  }
  cancel() { if (this.value.phase === 'downloading') { this.cancelled = true; this.driver.cancel(); } }
  async install() {
    if (this.value.mode !== 'installer' || this.value.phase !== 'downloaded') return;
    this.set({ phase: 'installing', error: null });
    try { await this.prepare(); this.driver.install(); }
    catch (error) { this.failInstall(error); }
  }
  failInstall(error: unknown) { if (this.value.phase === 'installing') this.set({ phase: 'downloaded', error: updateError(error) }); }
}
