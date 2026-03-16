import { Entity, Column } from 'typeorm';
import { omit } from 'lodash';
import { BaseEntity } from './base';
import { OmitVO } from '../utils/vo.utils';

@Entity({ name: 'user' })
export class UserEntity extends BaseEntity {
  @Column({ comment: '手机号' })
  phoneNumber: string;

  @Column({ comment: '用户昵称' })
  nickName: string;

  @Column({ comment: '密码' })
  password: string;

  @Column({ comment: '原始密码' })
  originPassword: string;

  @Column({ comment: '头像' })
  avatar?: string;

  @Column({ comment: '是否为会员' })
  isMember?: boolean;

  @Column({ comment: '会员到期时间' })
  memberDate?: string;

  @Column({ comment: '邀请码', default: '' })
  inviteCode?: string;

  toVO(): UserVO {
    const userVO = omit<UserEntity>(this, ['password', 'originPassword']) as UserVO;
    return userVO;
  }
}

export class UserVO extends OmitVO(UserEntity, ['password']) {
  avatarPath?: string;
}
