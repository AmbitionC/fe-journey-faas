import * as assert from 'assert';
import {
  createDocument,
  applyCommand,
  importDocument,
} from '../src/service/operations/model';

const input = {
  title: 'Example draft',
  body: 'Text',
  platform: 'xiaohongshu',
  images: [],
  note: 'Initial draft',
};
const at = '2026-10-10T12:00:00.000Z';
const edit = (doc: any, command: any) =>
  applyCommand(doc, command, 'admin', at);

describe('operations version and publication lifecycle', () => {
  it('creates an unpublished draft with no fabricated metrics', () => {
    const doc = createDocument(input, 'admin', at);
    assert.strictEqual(doc.status, 'draft');
    assert.deepStrictEqual(doc.publications, []);
    assert.deepStrictEqual(doc.reviews, []);
  });
  it('keeps published text and ordered images immutable after editing', () => {
    let doc = createDocument(
      {
        ...input,
        images: [
          { key: 'operations/images/a.png', name: 'a.png' },
          { key: 'operations/images/b.png', name: 'b.png' },
        ],
      },
      'admin',
      at
    );
    doc = edit(doc, {
      type: 'publish',
      publishedAt: at,
      url: 'https://example.com/post',
      note: 'Manually confirmed',
    });
    const snapshot = JSON.stringify(doc.versions[0]);
    doc = edit(doc, {
      type: 'save',
      ...input,
      title: 'Revised',
      images: [...doc.versions[0].images].reverse(),
      note: 'Reorder and revise',
    });
    assert.strictEqual(JSON.stringify(doc.versions[0]), snapshot);
    assert.strictEqual(doc.publications[0].versionId, doc.versions[0].id);
    assert.strictEqual(doc.status, 'draft');
    assert.strictEqual(doc.versions[1].images[0].name, 'b.png');
  });
  it('records simple status notes without implying publication', () => {
    let doc = createDocument(input, 'admin', at);
    for (const status of ['in_review', 'needs_changes', 'ready', 'archived']) {
      doc = edit(doc, { type: 'status', status, note: status });
    }
    assert.deepStrictEqual(doc.publications, []);
    assert.strictEqual(doc.events.length, 5);
    assert.throws(
      () => edit(doc, { type: 'status', status: 'published' }),
      /发布/
    );
  });
  it('requires a valid explicit publication time and safe link', () => {
    const doc = createDocument(input, 'admin', at);
    for (const publishedAt of ['', 'invalid', '2026-10-11T12:00:00Z']) {
      assert.throws(
        () => edit(doc, { type: 'publish', publishedAt, url: '' }),
        /时间/
      );
    }
    assert.throws(
      () =>
        edit(doc, {
          type: 'publish',
          publishedAt: at,
          url: 'javascript:alert(1)',
        }),
      /链接/
    );
    const published = edit(doc, { type: 'publish', publishedAt: at, url: '' });
    assert.strictEqual(published.publications[0].url, null);
  });
  it('keeps unknown metrics null, retains explicit zero and validates observations', () => {
    let doc = createDocument(input, 'admin', at);
    assert.throws(
      () =>
        edit(doc, { type: 'review', publicationId: 'missing', observedAt: at }),
      /发布/
    );
    doc = edit(doc, { type: 'publish', publishedAt: at });
    const command = {
      type: 'review',
      publicationId: doc.publications[0].id,
      observedAt: at,
      views: '',
      likes: 0,
      saves: null,
      comments: undefined,
      conclusion: 'Observe',
      nextSteps: 'Improve',
    };
    const reviewed = edit(doc, command);
    assert.deepStrictEqual(reviewed.reviews[0].metrics, {
      views: null,
      likes: 0,
      saves: null,
      comments: null,
    });
    for (const views of [-1, 1.5, '3', NaN, Infinity, true])
      assert.throws(() => edit(doc, { ...command, views }), /指标/);
    assert.throws(
      () => edit(doc, { ...command, observedAt: '2026-10-09T12:00:00Z' }),
      /时间/
    );
  });
  it('rejects external image URLs and malformed contents', () => {
    assert.throws(
      () =>
        createDocument(
          {
            ...input,
            images: [{ key: 'https://example.com/a.png', name: 'a' }],
          },
          'admin',
          at
        ),
      /图片/
    );
    assert.throws(
      () => createDocument({ ...input, title: '' }, 'admin', at),
      /标题/
    );
    assert.throws(
      () =>
        createDocument(
          {
            ...input,
            images: [{ key: 'operations/images/../a.png', name: 'a' }],
          },
          'admin',
          at
        ),
      /图片/
    );
  });
  it('imports old and new content as separate unpublished versions with independent images', () => {
    const doc = importDocument(
      {
        versions: [
          {
            ...input,
            status: 'needs_changes',
            title: 'Old',
            images: [{ key: 'operations/images/a.png', name: 'Old cover' }],
          },
          { ...input, status: 'in_review', title: 'New', images: [] },
        ],
      },
      'admin',
      at
    );
    assert.strictEqual(doc.status, 'in_review');
    assert.strictEqual(doc.versions[0].images.length, 1);
    assert.strictEqual(doc.versions[1].images.length, 0);
    assert.strictEqual(doc.events[1].status, 'needs_changes');
    assert.deepStrictEqual(doc.publications, []);
    assert.deepStrictEqual(doc.reviews, []);
    assert.throws(
      () =>
        importDocument(
          { versions: [{ ...input, status: 'published' }] },
          'admin',
          at
        ),
      /发布/
    );
  });
  it('reviewing an older publication records the event against that version', () => {
    let doc = createDocument(input, 'admin', at);
    doc = edit(doc, { type: 'publish', publishedAt: at });
    const publishedVersionId = doc.versions[0].id;
    doc = edit(doc, { type: 'save', ...input, title: 'Next draft' });
    doc = edit(doc, {
      type: 'review',
      publicationId: doc.publications[0].id,
      observedAt: at,
    });
    assert.strictEqual(
      doc.events[doc.events.length - 1].versionId,
      publishedVersionId
    );
  });
});
