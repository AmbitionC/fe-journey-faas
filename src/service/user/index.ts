import { Inject, Provide, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { RedisService } from '@midwayjs/redis';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { omit } from 'lodash';
import { TokenConfig } from '../../interface';
import { UserEntity } from '../../entity/user';
import { UserDTO } from '../../dto/user';
import { uuid } from '../../utils/uuid';
import { R } from '../../common/base.error.utils';
import { AiProxyService } from '../ai/proxy';
import { IrisCreditService } from '../ai/irisCredit';
import { EntitlementService } from '../entitlement';
import {
  isMembershipFree,
  hasValidMemberColumn,
  MembershipConfig,
} from '../../common/membership';
import {
  AVATAR_DAILY_UPLOADS,
  AVATAR_MAX_BYTES,
  OSS_PUBLIC_BASE,
  avatarObjectKey,
  avatarSeedOf,
  decodeAvatarPayload,
  isAllowedAvatar,
  sniffImage,
} from '../../common/avatar';
import { OssService } from '../content/oss';

@Provide()
export class UserService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Config('token')
  tokenConfig: TokenConfig;

  @Config('membership')
  membershipConfig: MembershipConfig;

  @Inject()
  redisService: RedisService;

  @Inject()
  aiProxyService: AiProxyService;

  @Inject()
  irisCredit: IrisCreditService;

  @Inject()
  entitlementService: EntitlementService;

  // 创建用户
  async createUser(user: UserDTO): Promise<any> {
    const entity = user.toEntity();
    const { phoneNumber } = user;
    // 1. 校验手机号是否已注册
    const isExist = (await this.userModel.countBy({ phoneNumber })) > 0;
    if (isExist) throw R.error('当前手机号已注册！');
    // 2. 对当前用户密码进行加密
    const password = bcrypt.hashSync(user.password);
    entity.password = password;
    entity.avatar = 'default';
    entity.inviteCode = uuid().slice(0, 8);
    // 新会员权益暂停发放；仅初始化新用户，不改已有用户的会员列或权益记录。
    // 两列 NOT NULL，显式赋值；客户端传来的会员标记始终不可信。
    entity.isMember = false;
    entity.memberDate = '1970-01-01 00:00:00';
    await this.userModel.save(entity);

    const { expire } = this.tokenConfig;
    const token = uuid();
    // multi可以实现redis指令并发执行
    await this.redisService
      .multi()
      .set(`token:${token}`, JSON.stringify({ userId: phoneNumber, role: entity.role || 'user' }))
      .expire(`token:${token}`, expire)
      .exec();
    return {
      success: true,
      // 验证码与 captchaId 是请求参数、不是用户属性，不回显（此前随 entity 原样透出）
      data: { ...omit(entity, ['password', 'captcha', 'captchaId']), expire, token },
    };
  }

  private async skillMembershipExpiry(userId: string): Promise<Date | null> {
    try {
      return (await this.entitlementService?.skillMembershipExpiry?.(userId)) || null;
    } catch {
      return null;
    }
  }

  async getUserById(userId: string): Promise<any> {
    const userInfo = await this.userModel
      .createQueryBuilder('user')
      .where('user.phoneNumber = :userId', { userId })
      .getOne();
    if (userInfo) {
      // 限时免费：所有人按会员对待，并下发远期到期日，让前端各处会员判定自动通过
      const freeForAll = !!isMembershipFree(this.membershipConfig);
      // 会员判定必须带上到期日。旧写法是 `freeForAll || !!userInfo.isMember`，
      // 而 isMember 列到期后不会被改回 false ⟹ 试用过期的用户照样拿到
      // isMember=true、会员额度和整套会员 UI；可 ai.ts 的限流是带日期判断的，
      // 于是界面说你是会员、接口按非会员拒。两处口径现已统一到 hasValidMemberColumn。
      const columnMember = hasValidMemberColumn(userInfo.isMember, userInfo.memberDate);
      // Skill 会员（owner 2026-10-31 定的唯一会员档）同样是网站会员：存量列无效时拿它的到期日当 memberDate
      const skillExpiry = freeForAll || columnMember ? null : await this.skillMembershipExpiry(userId);
      const isMember = freeForAll || columnMember || !!skillExpiry;
      const quota = await this.irisCredit.quota(userId, isMember).catch(() => null);
      const vo = userInfo.toVO();
      return {
        success: true,
        data: {
          ...vo,
          avatarSeed: avatarSeedOf(userInfo),
          // 回写计算后的会员态，别让前端读到库里那个只增不减的裸标记
          isMember,
          ...(freeForAll ? { memberDate: '2099-12-31 23:59:59' } : {}),
          ...(skillExpiry ? { memberDate: skillExpiry.toISOString().slice(0, 19).replace('T', ' ') } : {}),
          aiQuota: quota,
        },
      };
    }
    return { success: false, message: '用户不存在' };
  }

  async updateUser(
    userId: string,
    data: { nickName?: string; avatar?: string }
  ): Promise<any> {
    const user = await this.userModel.findOneBy({ phoneNumber: userId });
    if (!user) throw R.error('用户不存在');

    if (data.nickName !== undefined) user.nickName = data.nickName;
    if (data.avatar !== undefined) {
      const avatar = String(data.avatar || '').trim() || 'default';
      if (!isAllowedAvatar(avatar)) throw R.error('头像只能选预设或上传图片');
      user.avatar = avatar;
    }

    await this.userModel.save(user);
    return { success: true, data: { ...user.toVO(), avatarSeed: avatarSeedOf(user) } };
  }

  /** 上传头像：校验类型/大小/频率 → 写 OSS → 写回 user.avatar */
  async uploadAvatar(userId: string, payload: unknown, oss = new OssService()): Promise<any> {
    const user = await this.userModel.findOneBy({ phoneNumber: userId });
    if (!user) throw R.error('用户不存在');
    let buf: Buffer;
    try {
      buf = decodeAvatarPayload(payload);
    } catch (e: any) {
      throw R.error(e?.message || '图片读取失败');
    }
    if (!buf.length) throw R.error('没有收到图片');
    if (buf.length > AVATAR_MAX_BYTES) throw R.error('图片太大了，请换一张或裁小一点');
    const kind = sniffImage(buf);
    if (!kind) throw R.error('只支持 JPG、PNG、WebP 图片');

    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const rateKey = `avatar:upload:${userId}:${day}`;
    const used = Number(await this.redisService.incr(rateKey));
    if (used === 1) await this.redisService.expire(rateKey, 2 * 86400);
    if (used > AVATAR_DAILY_UPLOADS) throw R.error('今天换头像次数太多了，明天再试');

    const objKey = avatarObjectKey(userId, buf, kind.ext);
    await oss.putAvatar(objKey, buf, kind.mime);
    user.avatar = `${OSS_PUBLIC_BASE}/${objKey}`;
    await this.userModel.save(user);
    return { success: true, data: { ...user.toVO(), avatarSeed: avatarSeedOf(user) } };
  }

  async activateMembership(
    _userId: string,
    _plan: 'monthly' | 'yearly',
    _channel?: string
  ): Promise<any> {
    throw R.forbiddenError('会员售卖已暂停，已有权益继续有效');
  }
}
