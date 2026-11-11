import * as assert from 'assert';
import {
  ORT_SHELF_KEY,
  ortBookId,
  ortObjectKey,
  signOrtBook,
  signOrtShelf,
  toHttps,
} from '../src/service/kids/ort';

const sign = (key: string) => `signed:${key}`;

describe('栗栗学英语 牛津树签名', () => {
  it('书号只认 ort-l<级>-<两位编号>', () => {
    assert.strictEqual(ortBookId('ort-l2-05'), 'ort-l2-05');
    assert.strictEqual(ortBookId(' ort-l9-12 '), 'ort-l9-12');
    for (const bad of ['ort-l0-01', 'ort-l2-5', 'ort-l10-01', '../ort-l2-05', 'ort-l2-05/x', '', null, 3]) {
      assert.strictEqual(ortBookId(bad), null, String(bad));
    }
  });

  it('对象 key 落在 little-circle-web/ort/l<级>/<书号>/ 下', () => {
    assert.strictEqual(ortObjectKey('ort-l2-05', 'p03.webp'), 'little-circle-web/ort/l2/ort-l2-05/p03.webp');
    assert.strictEqual(ortObjectKey('ort-l2-05', 'l12.mp3'), 'little-circle-web/ort/l2/ort-l2-05/l12.mp3');
    assert.strictEqual(ortObjectKey('ort-l2-05', 'book.json'), 'little-circle-web/ort/l2/ort-l2-05/book.json');
    assert.strictEqual(ORT_SHELF_KEY, 'little-circle-web/ort/shelf.json');
  });

  it('越权路径和别的文件一律不签', () => {
    for (const bad of ['../shelf.json', '../../secret.txt', 'p03.webp/../../x', 'p03.png', 'a/p03.webp', '%2e%2e/p01.webp', '', null]) {
      assert.strictEqual(ortObjectKey('ort-l2-05', bad), null, String(bad));
    }
    assert.strictEqual(ortObjectKey('../ort-l2-05', 'p01.webp'), null);
  });

  it('一本书的封面、页图、音频都换成签名地址，没音频的句子保持 null', () => {
    const book = {
      id: 'whatever',
      cover: 'p01.webp',
      pages: [
        { image: 'p03.webp', lines: [{ en: 'Dad made a go-kart.', audio: 'l01.mp3' }] },
        { image: 'p04.webp', lines: [{ en: '', audio: null }] },
        { image: '../../evil.webp', lines: [{ en: 'x', audio: '../x.mp3' }] },
      ],
    };
    const out = signOrtBook('ort-l2-05', book, sign);
    assert.strictEqual(out.id, 'ort-l2-05');
    assert.strictEqual(out.cover, 'signed:little-circle-web/ort/l2/ort-l2-05/p01.webp');
    assert.strictEqual(out.pages![0].image, 'signed:little-circle-web/ort/l2/ort-l2-05/p03.webp');
    assert.strictEqual(out.pages![0].lines![0].audio, 'signed:little-circle-web/ort/l2/ort-l2-05/l01.mp3');
    assert.strictEqual(out.pages![1].lines![0].audio, null);
    assert.strictEqual(out.pages![2].image, '');
    assert.strictEqual(out.pages![2].lines![0].audio, null);
  });

  it('书目只留合法书号，封面签名', () => {
    const out = signOrtShelf(
      [
        { id: 'ort-l1-01', cover: 'p01.webp', title_en: 'At school' },
        { id: '../x', cover: 'p01.webp' },
        null,
      ],
      sign
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].cover, 'signed:little-circle-web/ort/l1/ort-l1-01/p01.webp');
    assert.deepStrictEqual(signOrtShelf({ not: 'a list' }, sign), []);
  });

  it('签名地址统一成 https', () => {
    assert.strictEqual(toHttps('http://b.oss-cn-hangzhou.aliyuncs.com/k?x=1'), 'https://b.oss-cn-hangzhou.aliyuncs.com/k?x=1');
    assert.strictEqual(toHttps('https://a/b'), 'https://a/b');
  });
});
