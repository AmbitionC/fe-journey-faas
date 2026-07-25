import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { InterviewEntity } from '../../entity/interview';
import { InterviewDTO } from '../../dto/interview';

@Provide()
export class InterviewService {
  @InjectEntityModel(InterviewEntity)
  interviewModel: Repository<InterviewEntity>;

  async saveInterview(interview: InterviewDTO): Promise<any> {
    const entity = interview.toEntity();
    // Check if url already exists
    const existing = await this.interviewModel.findOneBy({
      url: interview.url,
    });
    if (existing) {
      entity.id = existing.id;
    }

    // Ensure defaults
    if (!entity.source) entity.source = 'nowcoder';
    if (!entity.status) entity.status = 'verified';

    const result = await this.interviewModel.save(entity);
    return {
      success: true,
      data: result,
    };
  }

  async listInterviews(page = 1, pageSize = 10, status?: string): Promise<any> {
    const query = this.interviewModel.createQueryBuilder('interview');

    if (status) {
      query.where('interview.status = :status', { status });
    }

    // 默认不显示已删除的，除非显式查询 'deleted'
    // 注意 SQL NULL 语义：`status != 'deleted'` 对 status IS NULL 的行求值为 NULL（不匹配），
    // 早期入库未写 status 的面经会被整体过滤掉、表现为"列表空"，故显式放行 NULL。
    if (status !== 'deleted') {
      query.andWhere(
        '(interview.status IS NULL OR interview.status != :deletedStatus)',
        { deletedStatus: 'deleted' }
      );
    }

    query
      .orderBy('interview.createTime', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [list, total] = await query.getManyAndCount();

    return {
      success: true,
      data: {
        list,
        total,
        page,
        pageSize,
      },
    };
  }

  async deleteInterview(id: string): Promise<any> {
    // 软删除，更新状态为 deleted
    await this.interviewModel.update(id, { status: 'deleted' });
    return { success: true };
  }

  async updateInterviewStatus(id: string, status: string): Promise<any> {
    await this.interviewModel.update(id, { status });
    return { success: true };
  }
}
