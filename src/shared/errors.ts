export class AppError extends Error { constructor(message: string, public status?: number) { super(message); this.name = 'AppError'; } }
const messages: Record<number, string> = { 401: '认证失败，请检查用户名和密码，iCloud 等服务可能需要应用专用密码', 403: '服务器拒绝访问，请检查账户或日历权限', 404: '地址不存在，请填写更具体的 CalDAV 服务或日历地址', 405: '该地址不支持所需的 DAV 方法', 409: '服务器资源状态冲突，请重新同步', 412: '日程已在其他设备修改，已保留双方版本等待处理', 429: '服务器请求过多，请稍后重试', 507: '服务器空间不足或同步令牌已失效' };
export function httpError(status: number): AppError { return new AppError(`${messages[status] ?? (status >= 500 ? '服务器暂时不可用，请稍后重试' : 'CalDAV 请求失败')}（HTTP ${status}）`, status); }
export function redact(value: string): string {
  return value.replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, '$1[已隐藏]').replace(/(password|token|secret)(\s*[=:]\s*)([^\s&,;]+)/gi, '$1$2[已隐藏]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[已隐藏]@').replace(/([?&](?:access_token|password|token)=)[^&\s]+/gi, '$1[已隐藏]');
}
export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return redact(error.message);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return '请求已取消或超时，本地修改已保留';
  if (error instanceof Error && /certificate|CERT_|self.signed|TLS/i.test(error.message)) return 'TLS 证书验证失败，请为服务器安装受信任的证书';
  // Do not expose raw server bodies, fetch errors or credentials to the renderer.
  return '操作失败，请检查网络、服务器地址和输入内容；本地修改仍然保留';
}
