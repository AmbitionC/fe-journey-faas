import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Body,
  Query,
  ALL,
} from '@midwayjs/core';
import { InterviewDTO } from '../dto/interview';
import { InterviewService } from '../service/interview/index';

import { NoAuth } from '../decorator/noAuth';

@Provide()
export class InterviewHTTPService {
  @Inject()
  interviewService: InterviewService;

  @NoAuth()
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

  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取面试面经列表',
    functionName: 'listInterviews',
    name: 'listInterviews',
    path: '/interview/list',
    method: 'get',
  })
  async listInterviews(
    @Query('page') page: number,
    @Query('pageSize') pageSize: number,
    @Query('status') status: string
  ): Promise<any> {
    return await this.interviewService.listInterviews(
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 10,
      status
    );
  }

  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除面试面经',
    functionName: 'deleteInterview',
    name: 'deleteInterview',
    path: '/interview/delete',
    method: 'post',
  })
  async deleteInterview(@Body('id') id: string): Promise<any> {
    return await this.interviewService.deleteInterview(id);
  }

  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '更新面试面经状态',
    functionName: 'updateInterviewStatus',
    name: 'updateInterviewStatus',
    path: '/interview/status',
    method: 'post',
  })
  async updateInterviewStatus(
    @Body('id') id: string,
    @Body('status') status: string
  ): Promise<any> {
    return await this.interviewService.updateInterviewStatus(id, status);
  }
}
