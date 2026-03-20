import { Provide } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { BookEntity } from '../../entity/book';

@Provide()
export class BookService {
  @InjectEntityModel(BookEntity)
  bookModel: Repository<BookEntity>;

  async getList(): Promise<any> {
    const records = await this.bookModel.find({
      where: { status: 'active' },
      order: { sortOrder: 'DESC', createTime: 'DESC' },
    });
    const safeRecords = records.map(({ pdfResourceUrl, ...rest }) => rest);
    return { success: true, data: safeRecords };
  }

  async getDetail(id: number): Promise<any> {
    const record = await this.bookModel.findOne({ where: { id: id as any } });
    if (!record) {
      return { success: false, message: '书籍不存在' };
    }
    return { success: true, data: record };
  }

  async save(data: Partial<BookEntity>): Promise<any> {
    if (data.id) {
      const { id, ...updateData } = data;
      await this.bookModel.update(id, updateData);
      return { success: true, message: '更新成功' };
    }
    const entity = this.bookModel.create(data);
    const saved = await this.bookModel.save(entity);
    return { success: true, data: saved, message: '创建成功' };
  }

  async delete(id: number): Promise<any> {
    await this.bookModel.delete(id);
    return { success: true, message: '删除成功' };
  }
}
