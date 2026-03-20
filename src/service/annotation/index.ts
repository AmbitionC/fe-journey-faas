import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleAnnotationEntity } from '../../entity/articleAnnotation';
import { UserEntity } from '../../entity/user';
import { R } from '../../common/base.error.utils';

@Provide()
export class AnnotationService {
  @InjectEntityModel(ArticleAnnotationEntity)
  annotationModel: Repository<ArticleAnnotationEntity>;

  @InjectEntityModel(UserEntity)
  userModel: Repository<UserEntity>;

  async createAnnotation(
    userId: string,
    data: {
      articleKey: string;
      module: string;
      type: string;
      selectedText: string;
      prefixText: string;
      suffixText: string;
      noteContent?: string;
    }
  ) {
    let nickName = '';
    try {
      const user = await this.userModel.findOneBy({ phoneNumber: userId });
      nickName = user?.nickName || '';
    } catch {
      // ignore
    }

    const annotation = await this.annotationModel.save({
      userId,
      nickName,
      articleKey: data.articleKey,
      module: data.module,
      type: data.type,
      selectedText: data.selectedText,
      prefixText: data.prefixText || '',
      suffixText: data.suffixText || '',
      noteContent: data.type === 'note' ? data.noteContent || '' : null,
    });
    return annotation;
  }

  async getAnnotations(articleKey: string, module: string) {
    const list = await this.annotationModel.find({
      where: { articleKey, module },
      order: { createTime: 'ASC' },
    });
    return list.map(item => ({
      id: item.id,
      userId: item.userId,
      nickName: item.nickName,
      type: item.type,
      selectedText: item.selectedText,
      prefixText: item.prefixText,
      suffixText: item.suffixText,
      noteContent: item.noteContent,
      createTime: item.createTime,
    }));
  }

  async deleteAnnotation(id: number, userId: string) {
    const annotation = await this.annotationModel.findOneBy({ id: id as any });
    if (!annotation) {
      throw R.error('标注不存在');
    }
    if (annotation.userId !== userId) {
      throw R.forbiddenError('只能删除自己的标注');
    }
    await this.annotationModel.remove(annotation);
    return { success: true };
  }
}
