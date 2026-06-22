import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { UserGoalEntity } from '../../entity/userGoal';
import { LearningPathEntity } from '../../entity/learningPath';

@Provide()
export class LearningService {
  @InjectEntityModel(UserGoalEntity)
  goalModel: Repository<UserGoalEntity>;

  @InjectEntityModel(LearningPathEntity)
  pathModel: Repository<LearningPathEntity>;

  async getGoal(userId: string) {
    return this.goalModel.findOne({ where: { userId } });
  }

  async saveGoal(p: {
    userId: string;
    target: string;
    level?: string;
    interests?: string[];
    note?: string;
  }) {
    const existing = await this.goalModel.findOne({ where: { userId: p.userId } });
    if (existing) {
      Object.assign(existing, p);
      return this.goalModel.save(existing);
    }
    return this.goalModel.save(this.goalModel.create(p));
  }

  /** 目标摘要，拼进画像供 AI 个性化（PRD-03 → PRD-01/02）。 */
  async goalSummary(userId: string): Promise<string> {
    const g = await this.getGoal(userId);
    if (!g) return '';
    const T: Record<string, string> = {
      job: '求职/校招',
      advance: '在职进阶',
      ai: '转 AI 方向',
      other: '其他',
    };
    const L: Record<string, string> = { beginner: '入门', mid: '中级', senior: '高级' };
    return `目标：${T[g.target] || g.target}${g.level ? `，水平：${L[g.level] || g.level}` : ''}${
      g.interests?.length ? `，兴趣：${g.interests.join('、')}` : ''
    }`;
  }

  async listPaths(includeAll = false) {
    const where = includeAll ? {} : { status: 'published' };
    return this.pathModel.find({ where, order: { orderNum: 'ASC', id: 'ASC' } });
  }

  async getPath(slug: string) {
    return this.pathModel.findOne({ where: { slug } });
  }

  async savePath(data: Partial<LearningPathEntity> & { id?: number }) {
    if (data.id) {
      const existing = await this.pathModel.findOneBy({ id: String(data.id) });
      if (!existing) throw new Error('路径不存在');
      Object.assign(existing, data);
      return this.pathModel.save(existing);
    }
    return this.pathModel.save(this.pathModel.create(data));
  }

  async deletePath(id: number) {
    await this.pathModel.delete({ id: String(id) });
    return { deleted: true };
  }
}
