import {
  Provide,
  ServerlessTrigger,
  ServerlessTriggerType,
  Inject,
  Query,
  Body,
  ALL,
} from '@midwayjs/core';
import { Context } from '@midwayjs/faas';
import { AnnotationService } from '../service/annotation';
import { NoAuth } from '../decorator/noAuth';
import {
  CreateAnnotationDTO,
  QueryAnnotationsDTO,
  DeleteAnnotationDTO,
} from '../dto/annotation';

@Provide()
export class AnnotationHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  annotationService: AnnotationService;

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建标注（划线/笔记）',
    functionName: 'createAnnotation',
    name: 'createAnnotation',
    path: '/article/annotation',
    method: 'post',
  })
  async createAnnotation(@Body(ALL) body: CreateAnnotationDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.annotationService.createAnnotation(userId, body);
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取文章的所有标注',
    functionName: 'getAnnotations',
    name: 'getAnnotations',
    path: '/article/annotations',
    method: 'get',
  })
  @NoAuth()
  async getAnnotations(@Query(ALL) query: QueryAnnotationsDTO) {
    const data = await this.annotationService.getAnnotations(
      query.articleKey,
      query.module
    );
    return { success: true, data };
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除标注',
    functionName: 'deleteAnnotation',
    name: 'deleteAnnotation',
    path: '/article/annotation/delete',
    method: 'post',
  })
  async deleteAnnotation(@Body(ALL) body: DeleteAnnotationDTO) {
    const userId = body.userId || this.ctx.userInfo?.userId;
    const data = await this.annotationService.deleteAnnotation(
      body.id,
      userId
    );
    return { success: true, data };
  }
}
