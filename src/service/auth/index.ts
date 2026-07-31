import { Inject, Provide, Config, ILogger } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { RedisService } from '@midwayjs/redis';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { TokenConfig } from '../../interface';
import { UserEntity } from '../../entity/user';
import { LoginDTO } from '../../dto/auth';
import { uuid } from '../../utils/uuid';
import { TokenVO } from '../../vo';
import { R } from '../../common/base.error.utils';

@Provide()
export class AuthService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Config('token')
  tokenConfig: TokenConfig;

  @Inject()
  redisService: RedisService;

  @Inject()
  logger: ILogger;

  async login(data: LoginDTO): Promise<any> {
    const { accountNumber, password } = data;
    const user = await this.userModel
      .createQueryBuilder('user')
      .where('user.phoneNumber = :accountNumber', { accountNumber })
      .select(['user.id', 'user.password', 'user.role'])
      .getOne();

    if (!user) {
      throw R.error('账号或密码错误！');
    }

    if (!bcrypt.compareSync(password, user.password)) {
      throw R.error('用户名或密码错误！');
    }

    const { expire } = this.tokenConfig;

    const token = uuid();

    // multi可以实现redis指令并发执行
    await this.redisService
      .multi()
      .set(`token:${token}`, JSON.stringify({ userId: accountNumber, role: user.role || 'user' }))
      .expire(`token:${token}`, expire)
      .exec();

    const responseData: TokenVO = {
      expire,
      token,
    };

    return {
      data: responseData,
      success: true,
    };
  }
}
