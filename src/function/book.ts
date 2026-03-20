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
import { BookService } from '../service/book';
import { BookOrderService } from '../service/bookOrder';
import { NoAuth } from '../decorator/noAuth';

@Provide()
export class BookHTTPService {
  @Inject()
  ctx: Context;

  @Inject()
  bookService: BookService;

  @Inject()
  bookOrderService: BookOrderService;

  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取书籍列表',
    functionName: 'getBookList',
    name: 'getBookList',
    path: '/book/list',
    method: 'get',
  })
  async getBookList(): Promise<any> {
    return await this.bookService.getList();
  }

  @NoAuth()
  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '获取书籍详情',
    functionName: 'getBookDetail',
    name: 'getBookDetail',
    path: '/book/detail',
    method: 'get',
  })
  async getBookDetail(@Query('id') id: string): Promise<any> {
    return await this.bookService.getDetail(Number(id));
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '创建书籍订单',
    functionName: 'createBookOrder',
    name: 'createBookOrder',
    path: '/book/order/create',
    method: 'post',
  })
  async createBookOrder(
    @Body(ALL)
    body: {
      userId: string;
      bookId: number;
      bookTitle: string;
      versionType: string;
      amount: number;
    },
  ): Promise<any> {
    return await this.bookOrderService.create(body);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '确认书籍订单支付',
    functionName: 'confirmBookOrder',
    name: 'confirmBookOrder',
    path: '/book/order/confirm',
    method: 'post',
  })
  async confirmBookOrder(
    @Body(ALL) body: { orderNo: string },
  ): Promise<any> {
    return await this.bookOrderService.confirm(body.orderNo);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '查询书籍订单',
    functionName: 'getBookOrders',
    name: 'getBookOrders',
    path: '/book/orders',
    method: 'get',
  })
  async getBookOrders(@Query('userId') userId: string): Promise<any> {
    return await this.bookOrderService.getOrders(userId);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '保存书籍（管理端）',
    functionName: 'saveBook',
    name: 'saveBook',
    path: '/book/save',
    method: 'post',
  })
  async saveBook(@Body(ALL) body: any): Promise<any> {
    return await this.bookService.save(body);
  }

  @ServerlessTrigger(ServerlessTriggerType.HTTP, {
    description: '删除书籍（管理端）',
    functionName: 'deleteBook',
    name: 'deleteBook',
    path: '/book/delete',
    method: 'post',
  })
  async deleteBook(@Body(ALL) body: { id: number }): Promise<any> {
    return await this.bookService.delete(body.id);
  }
}
