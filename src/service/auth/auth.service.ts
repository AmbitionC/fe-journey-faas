import { Inject, Provide, Config } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { RedisService } from '@midwayjs/redis';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { TokenConfig } from './interface';
import { UserEntity } from '../../entity/user';
import { R } from '../../common/base.error.utils';

@Provide()
export class AuthService {
  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  @Config('token')
  tokenConfig: TokenConfig;

  @Inject()
  redisService: RedisService;

  async login(loginDTO: LoginDTO): Promise<any> {
    const { accountNumber } = loginDTO;
    const user = await this.userModel
      .createQueryBuilder('user')
      .where('user.phoneNumber = :accountNumber', { accountNumber })
      .select(['user.id', 'user.password'])
      .getOne();

    if (!user) {
      throw R.error('账号或密码错误！');
    }

    if (!bcrypt.compareSync(loginDTO.password, user.password)) {
      throw R.error('用户名或密码错误！');
    }

    const { expire } = this.tokenConfig;

    const token = uuid();

    // multi可以实现redis指令并发执行
    await this.redisService
      .multi()
      .set(`token:${token}`, user.id)
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
