import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  ALL,
} from '@midwayjs/core';
import { InterviewDTO } from '../dto/interview';
import { InterviewService } from '../service/interview/index';

@Provide()
export class InterviewHTTPService {
  @Inject()
  interviewService: InterviewService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存面试面经',
    functionName: 'saveInterview',
    name: 'saveInterview',
    path: '/interview/save',
    method: 'post',
  })
  async saveInterview(@Body(ALL) data: InterviewDTO): Promise<any> {
    return await this.interviewService.saveInterview(data);
  }
}
