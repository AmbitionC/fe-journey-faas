import { createHttpRequest } from '@midwayjs/mock';
import { getApp } from './setup';
import * as assert from 'assert';

describe('test/index.test.ts', () => {

  it('should get result from http trigger', async () => {
    const app = getApp();
    const result = await createHttpRequest(app).get('/').query({
      name: 'Midway.js'
    })
    assert(result.text === 'Hello Midway.js');
  });
});
