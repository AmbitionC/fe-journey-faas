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
}
