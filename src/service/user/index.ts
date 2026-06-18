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

@Provide()
export class UserService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Config('token')
  tokenConfig: TokenConfig;

  @Inject()
  redisService: RedisService;

  @Inject()
  aiProxyService: AiProxyService;

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
      data: { ...omit(entity, ['password']), expire, token },
    };
  }

  async getUserById(userId: string): Promise<any> {
    const userInfo = await this.userModel
      .createQueryBuilder('user')
      .where('user.phoneNumber = :userId', { userId })
      .getOne();
    if (userInfo) {
      const quota = await this.aiProxyService.getQuota(userId, !!userInfo.isMember);
      return {
        success: true,
        data: { ...userInfo.toVO(), aiQuota: quota },
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

  async activateMembership(userId: string, plan: 'monthly' | 'yearly'): Promise<any> {
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

    return { success: true, data: user.toVO() };
  }
}
