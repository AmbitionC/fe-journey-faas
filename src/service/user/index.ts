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
import { EntitlementService, TRIAL_DAYS } from '../entitlement';
import { OrderService } from '../order';
import { isMembershipFree, MembershipConfig } from '../../common/membership';

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
  entitlementService: EntitlementService;

  @Inject()
  orderService: OrderService;

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
    // 注册即送 14 天全功能会员——服务端权威发放。三条约束缺一不可：
    // 1) isMember / memberDate 两列 NOT NULL 且无默认值，必须显式赋值，否则 save 被
    //    库拒（"Field 'isMember' doesn't have a default value"，2026-08-10 踩过）；
    // 2) 但不能赋 false/''：ai.ts、quiz.ts、metrics「会员数」与前端所有会员 UI 仍直接
    //    读这两列（entitlement 受 ENTITLEMENT_ENABLED 灰度，尚未成为唯一判定）。赋假值
    //    会让全站在售的「注册即送 14 天」变成空头承诺——2026-08-10~08-23 线上即如此，
    //    期间注册用户实际只拿到免费额度（08-23 复盘发现：users 50 / members 45）；
    // 3) 不采信前端传入的 isMember/memberDate：客户端可改参数白嫖长期会员。
    const trialExpireAt = new Date(Date.now() + TRIAL_DAYS * 86400000);
    entity.isMember = true;
    entity.memberDate = trialExpireAt.toISOString().slice(0, 19).replace('T', ' ');
    await this.userModel.save(entity);

    // PRD-07：注册即发放 14 天全功能试用（服务端权威，每手机号一次；幂等）。
    // 权益记录只在 ENTITLEMENT_ENABLED 开启后被消费，与上面的 isMember 列双写。
    await this.entitlementService.grantTrial(phoneNumber);

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
      data: { ...omit(entity, ['password']), expire, token },
    };
  }

  async getUserById(userId: string): Promise<any> {
    const userInfo = await this.userModel
      .createQueryBuilder('user')
      .where('user.phoneNumber = :userId', { userId })
      .getOne();
    if (userInfo) {
      // 限时免费：所有人按会员对待，并下发远期到期日，让前端各处会员判定自动通过
      const freeForAll = !!isMembershipFree(this.membershipConfig);
      const isMember = freeForAll || !!userInfo.isMember;
      const quota = await this.aiProxyService.getQuota(userId, isMember);
      const vo = userInfo.toVO();
      return {
        success: true,
        data: {
          ...vo,
          ...(freeForAll
            ? { isMember: true, memberDate: '2099-12-31 23:59:59' }
            : {}),
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
    if (data.avatar !== undefined) user.avatar = data.avatar;

    await this.userModel.save(user);
    return { success: true, data: user.toVO() };
  }

  async activateMembership(
    userId: string,
    plan: 'monthly' | 'yearly',
    channel?: string
  ): Promise<any> {
    const user = await this.userModel.findOneBy({ phoneNumber: userId });
    if (!user) throw R.error('用户不存在');

    // If already a member with future date, extend from that date; otherwise start from now
    const baseDate = (user.isMember && user.memberDate && new Date(user.memberDate) > new Date())
      ? new Date(user.memberDate)
      : new Date();

    const days = plan === 'yearly' ? 365 : 30;
    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + days);

    user.isMember = true;
    user.memberDate = newExpiry.toISOString().slice(0, 19).replace('T', ' ');
    await this.userModel.save(user);

    // PRD-07：同步写入权益记录，让新权益网关与存量 isMember 标记一致（过渡期双写）。
    await this.entitlementService.grantFromOrder(userId, plan).catch(() => {});

    // 订单落库：会员账单页与增长漏斗此前无数据源（order 表从未被写入）
    await this.orderService
      .create({
        userId,
        type: 'member',
        name: plan === 'yearly' ? '年付会员 · Iris Pro' : '月付会员 · Iris Pro',
        amount: plan === 'yearly' ? 199 : 29,
        channel,
      })
      .catch(() => {});

    return { success: true, data: user.toVO() };
  }
}
