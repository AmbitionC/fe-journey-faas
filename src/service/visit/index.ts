import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { VisitLogEntity } from '../../entity/visitLog';

@Provide()
export class VisitService {
  @InjectEntityModel(VisitLogEntity)
  visitLogModel: Repository<VisitLogEntity>;

  async recordVisit(userId: string): Promise<any> {
    const today = new Date().toISOString().split('T')[0];
    const existing = await this.visitLogModel.findOneBy({
      userId,
      visitDate: today,
    });

    if (existing) {
      existing.count += 1;
      await this.visitLogModel.save(existing);
    } else {
      await this.visitLogModel.save({
        userId,
        visitDate: today,
        count: 1,
      });
    }

    return { success: true };
  }

  async getVisitStats(userId: string): Promise<any> {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const startDate = oneYearAgo.toISOString().split('T')[0];

    const records = await this.visitLogModel
      .createQueryBuilder('log')
      .where('log.userId = :userId', { userId })
      .andWhere('log.visitDate >= :startDate', { startDate })
      .orderBy('log.visitDate', 'ASC')
      .getMany();

    const data = records.map(r => ({
      date: r.visitDate,
      count: r.count,
    }));

    return { success: true, data };
  }
}
