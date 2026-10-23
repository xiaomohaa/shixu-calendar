import { describe, expect, it, vi } from 'vitest';
import { UpdateController, type UpdateDriver, updateError } from '../src/main/update-controller';
import { defaultSettings, settingsSchema } from '../src/shared/contracts';
const release = { version: '1.3.0', notes: '新增功能', date: null };
function setup(mode: 'installer' | 'portable' | 'development' = 'installer') {
  const driver: UpdateDriver = { check: vi.fn(async () => release), download: vi.fn(async () => {}), cancel: vi.fn(), install: vi.fn() };
  const prepare = vi.fn(async () => {}), changed = vi.fn();
  return { driver, prepare, changed, controller: new UpdateController('1.2.0', mode, driver, changed, prepare) };
}
describe('更新控制与旧偏好兼容', () => {
  it('旧版偏好自动获得更新检查、关闭到托盘与粗体默认值', () => { const { autoUpdateCheck, closeToTray, boldText, ...old } = defaultSettings; expect(settingsSchema.parse(old)).toMatchObject({ autoUpdateCheck: true, closeToTray: true, boldText: false }); });
  it('未检查和未完成下载均不能执行安装', async () => { const { controller, driver } = setup(); await controller.install(); await controller.check(); await controller.install(); expect(driver.install).not.toHaveBeenCalled(); });
  it('检查并发去重，检查成功后记录时间，不自动下载', async () => {
    const { controller, driver } = setup(); const a = controller.check(), b = controller.check(); expect(a).toBe(b); await a;
    expect(driver.check).toHaveBeenCalledTimes(1); expect(driver.download).not.toHaveBeenCalled(); expect(controller.state()).toMatchObject({ phase: 'available', release }); expect(controller.state().lastChecked).not.toBeNull();
  });
  it('下载完整校验成功后才准备退出并执行安装，已下载时不清除状态', async () => {
    const { controller, driver, prepare } = setup(); await controller.check(); await controller.download(); await controller.check(); expect(controller.state().phase).toBe('downloaded');
    expect(driver.install).not.toHaveBeenCalled(); await controller.install(); expect(prepare).toHaveBeenCalledTimes(1); expect(driver.install).toHaveBeenCalledTimes(1); expect(controller.state().phase).toBe('installing');
  });
  it('文件完整性错误不能安装，可重新下载后安装', async () => {
    const { controller, driver } = setup(); vi.mocked(driver.download).mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    await controller.check(); await controller.download(); await controller.install(); expect(driver.install).not.toHaveBeenCalled(); expect(controller.state().error).toContain('校验失败');
    await controller.download(); expect(controller.state().phase).toBe('downloaded');
  });
  it('取消下载回到可下载状态，不误判为完成', async () => {
    const { controller, driver } = setup(); let reject!: (error: Error) => void;
    vi.mocked(driver.download).mockImplementation(() => new Promise((_ok, fail) => { reject = fail; }));
    vi.mocked(driver.cancel).mockImplementation(() => reject(new Error('cancelled')));
    await controller.check(); const task = controller.download(); controller.cancel(); await task;
    expect(controller.state()).toMatchObject({ phase: 'available', error: null }); await controller.install(); expect(driver.install).not.toHaveBeenCalled();
  });
  it('便携版只检查，不下载和安装；开发模式不请求更新', async () => {
    const portable = setup('portable'); await portable.controller.check(); await portable.controller.download(); await portable.controller.install(); expect(portable.driver.check).toHaveBeenCalled(); expect(portable.driver.download).not.toHaveBeenCalled();
    const dev = setup('development'); await dev.controller.check(); expect(dev.driver.check).not.toHaveBeenCalled();
  });
  it('网络错误可重试，无更新时清除旧版本提示', async () => {
    const { controller, driver } = setup(); vi.mocked(driver.check).mockRejectedValueOnce(new Error('network secret')).mockResolvedValueOnce(null);
    await controller.check(); expect(controller.state().error).not.toContain('secret'); await controller.check(); expect(controller.state()).toMatchObject({ phase: 'current', release: null, error: null });
  });
  it('退出准备失败和安装驱动异步错误允许重试', async () => {
    const { controller, driver, prepare } = setup(); await controller.check(); await controller.download(); prepare.mockRejectedValueOnce(new Error('fail'));
    await controller.install(); expect(driver.install).not.toHaveBeenCalled(); expect(controller.state().phase).toBe('downloaded');
    await controller.install(); controller.failInstall(new Error('installer failed')); expect(controller.state().phase).toBe('downloaded');
  });
  it('错误信息不透出服务器响应和路径', () => { expect(updateError(new Error('404 credentials=secret'))).not.toContain('secret'); expect(updateError(new Error('CERT_INVALID'))).toContain('证书'); });
});
