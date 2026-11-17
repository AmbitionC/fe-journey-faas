import * as assert from 'assert';
import {
  renderDigestHtml,
  unsubscribeSig,
  unsubscribeUrl,
  verifyUnsubscribe,
} from '../src/common/digestMail';

describe('每周学习邮件', () => {
  it('退订签名：同一用户能验过，换用户或换密钥验不过', () => {
    const sig = unsubscribeSig('k1', 'u1');
    assert.strictEqual(verifyUnsubscribe('k1', 'u1', sig), true);
    assert.strictEqual(verifyUnsubscribe('k1', 'u2', sig), false);
    assert.strictEqual(verifyUnsubscribe('k2', 'u1', sig), false);
    assert.strictEqual(verifyUnsubscribe(undefined, 'u1', sig), false);
    assert.strictEqual(verifyUnsubscribe('k1', 'u1', 'short'), false);
  });

  it('没有密钥时退订链接落到个人中心', () => {
    assert.ok(unsubscribeUrl(undefined, 'u1').endsWith('/profile'));
    assert.ok(unsubscribeUrl('k1', 'u1').includes('/notify/unsubscribe/link?u=u1&s='));
  });

  it('正文用文章标题和直达链接，并转义', () => {
    const html = renderDigestHtml({
      reviewDue: [{ articleKey: 'rag-intro', reason: '上次只答对一半' }],
      titles: new Map([['rag-intro', { title: 'RAG <概述>' }]]),
      unsubscribe: 'https://x/unsub',
    });
    assert.ok(html.includes('RAG &lt;概述&gt;'));
    assert.ok(html.includes('/knowledge?activeKey=rag-intro'));
    assert.ok(html.includes('https://x/unsub'));
  });
});
