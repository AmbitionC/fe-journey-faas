/** Local browser verification only: synthetic login + durable test adapter, never production. */
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OperationsService } from '../src/service/operations';
import { OperationsHTTPService } from '../src/function/operations';
import { FileOperationsRepository } from './operations.repo';

// Optional owned test directory lets browser verification restart the service and reload its fixture.
const directory =
  process.env.OPERATIONS_TEST_DIRECTORY ||
  mkdtempSync(join(tmpdir(), 'operations-browser-'));
mkdirSync(directory, { recursive: true });
const service = new OperationsService();
service.model = new FileOperationsRepository(
  join(directory, 'rows.json')
) as any;
service.ossService = {
  signedUrl: key =>
    `http://127.0.0.1:7003/asset?key=${encodeURIComponent(key)}`,
  putPrivate: async (key, bytes) =>
    writeFileSync(join(directory, key.split('/').pop()), bytes),
} as any;
const routes = {
  '/operations/list': 'list',
  '/operations/detail': 'detail',
  '/operations/create': 'create',
  '/operations/command': 'command',
  '/operations/import': 'importContent',
  '/operations/image/upload': 'upload',
  '/operations/image/preview': 'preview',
};
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:8000');
  res.setHeader('Access-Control-Allow-Headers', 'token,Content-Type');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/ops/group-qr/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ success: true, data: { exists: true, staleDays: 0 } })
    );
    return;
  }
  if (url.pathname === '/bootstrap') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<script>location.href="http://127.0.0.1:8000/#/operations"</script>'
    );
    return;
  }
  if (url.pathname === '/asset') {
    try {
      const key = url.searchParams.get('key');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Type',
        key.endsWith('.webp')
          ? 'image/webp'
          : key.endsWith('.jpg')
            ? 'image/jpeg'
            : 'image/png'
      );
      res.end(
        readFileSync(
          join(directory, url.searchParams.get('key').split('/').pop())
        )
      );
    } catch {
      res.statusCode = 404;
      res.end();
    }
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const api = new OperationsHTTPService();
    api.ctx = { header: req.headers } as any;
    api.redisService = {
      get: async key =>
        key === 'token:operations-local-test'
          ? JSON.stringify({ userId: 'synthetic-admin', role: 'admin' })
          : null,
    } as any;
    api.operationsService = service;
    const name = routes[url.pathname];
    if (!name) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const parameter = url.pathname.endsWith('/detail')
      ? url.searchParams.get('id')
      : url.pathname.endsWith('/preview')
        ? url.searchParams.get('key')
        : req.method === 'GET'
          ? Object.fromEntries(url.searchParams)
          : body;
    const result = await (api as any)[name](parameter);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: e.message }));
  }
}).listen(7003, '127.0.0.1', () =>
  console.log(
    'Synthetic operations test API on 127.0.0.1:7003; file storage:',
    directory
  )
);
