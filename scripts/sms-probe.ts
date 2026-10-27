/**
 * 短信认证密钥自检（不发短信、不花钱）：拿部署用的同一组密钥调一次
 * CheckSmsVerifyCode，核一个不存在的验证码。
 *
 * - 密钥 / 签名算法 / RAM 权限任一不对：阿里云回 SignatureDoesNotMatch、
 *   InvalidAccessKeyId.*、Forbidden.* 之类 ⟹ 本脚本退出码 1；
 * - 都对：回 Code=OK、VerifyResult=UNKNOWN（或号码无记录类业务码）⟹ 退出码 0。
 * 赠送签名名称只有真发短信才验得出来，这里只打印出来核对。
 *
 * 用法：sms-probe workflow（push ops/sms-probe.trigger 或手动触发）。
 * 结果同时写 ::notice:: 注解——Actions 日志不一定取得到，注解可经 API 读。
 */
import { callRpc } from '../src/common/aliyunRpc';

function say(msg: string) {
  console.log(msg);
  console.log('::notice::' + msg);
}

async function main(): Promise<number> {
  const id = (process.env.SMS_ACCESS_KEY_ID || '').trim();
  const secret = (process.env.SMS_ACCESS_KEY_SECRET || '').trim();
  const sign = (process.env.SMS_SIGN_NAME || '').trim();
  say(
    `SMS_ACCESS_KEY_ID ${
      id ? `已配置（${id.slice(0, 4)}…，${id.length} 位）` : '缺失'
    }；` +
      `SMS_ACCESS_KEY_SECRET ${
        secret ? `已配置（${secret.length} 位）` : '缺失'
      }；` +
      `签名 ${sign ? `「${sign}」` : '缺失'}`
  );
  if (!id || !secret) {
    console.log('::error::密钥未配置');
    return 1;
  }
  const res = await callRpc({
    endpoint: 'https://dypnsapi.aliyuncs.com/',
    action: 'CheckSmsVerifyCode',
    version: '2017-05-25',
    accessKeyId: id,
    accessKeySecret: secret,
    params: { PhoneNumber: '13800000000', VerifyCode: '000000' },
  });
  say(
    `阿里云返回 Code=${res?.Code} Message=${res?.Message} ` +
      `VerifyResult=${res?.Model?.VerifyResult ?? '-'} RequestId=${
        res?.RequestId ?? '-'
      }`
  );
  if (
    /Signature|AccessKey|Forbidden|NoPermission|Unauthorized|InvalidTimeStamp|HTTP_/i.test(
      String(res?.Code)
    )
  ) {
    console.log('::error::密钥 / 签名算法 / 权限不对，见上一行');
    return 1;
  }
  say('自检通过：密钥、签名算法、RAM 权限均可用（未发送任何短信）');
  return 0;
}

main().then(
  code => process.exit(code),
  e => {
    console.log(`::error::自检异常：${e?.message || e}`);
    process.exit(1);
  }
);
