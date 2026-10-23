import { AppError } from '../shared/errors';
export interface CryptoProvider { available(): Promise<boolean>; encrypt(text: string): Promise<Buffer>; decrypt(data: Buffer): Promise<string> }
export class Vault {
  constructor(private provider: CryptoProvider) {}
  async seal(password: string) { if (!await this.provider.available()) throw new AppError('系统安全凭据存储不可用，无法保存账户密码'); return (await this.provider.encrypt(password)).toString('base64'); }
  async open(ciphertext: string) { if (!await this.provider.available()) throw new AppError('系统安全凭据存储不可用，请重新登录 Windows 后重试'); try { return await this.provider.decrypt(Buffer.from(ciphertext, 'base64')); } catch { throw new AppError('无法解密此账户凭据，请重新输入密码'); } }
}
