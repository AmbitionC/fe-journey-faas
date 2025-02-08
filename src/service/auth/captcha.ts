import { Inject, Provide, Config } from '@midwayjs/core';
import { CacheManager } from '@midwayjs/cache';
import * as svgCaptcha from 'svg-captcha';
import * as svgBase64 from 'mini-svg-data-uri';
import { CaptchaOptions } from '../../interface';
import { uuid } from '../../utils/uuid';

@Provide()
export class CaptchaService {
  @Inject()
  cacheManager: CacheManager;

  @Config('captcha')
  captcha: CaptchaOptions;

  // 获取验证码
  async getCaptcha(options?: CaptchaOptions) {
    const { data, text } = svgCaptcha.createMathExpr(options);
    const id = await this.setCatche(text);
    return {
      id,
      imageBase64: svgBase64(data),
    };
  }

  // 验证缓存
  async checkCaptcha(id: string, value: string): Promise<boolean> {
    if (!id || !value) {
      return false;
    }
    const storeId = this.getStoreId(id);
    const storedValue = await this.cacheManager.get(storeId);
    if (value.toLowerCase() !== storedValue) {
      return false;
    }
    this.cacheManager.del(storeId);
    return true;
  }

  // 设置缓存
  private async setCatche(text: string) {
    const id = uuid();
    await this.cacheManager.set(
      this.getStoreId(id),
      (text || '').toLowerCase(),
      { ttl: this.captcha.expirationTime }
    );
    return id;
  }

  // 获取缓存key
  private getStoreId(id: string) {
    if (!this.captcha.idPrefix) {
      return id;
    }
    return `${this.captcha.idPrefix}:${id}`;
  }
}
