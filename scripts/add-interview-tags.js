/**
 * 给 nav_config 表的 interview 导航数据按 key 合并 tags（增量、只动 interview）。
 *
 * - 读取当前 DB 的 interview navData → 备份到 /tmp/interview-navdata-backup.json
 * - 从 /tmp/interview-tags.json 读取 {key: tags} 映射（由前端常量提取）
 * - 递归给叶子节点写入 tags
 * - 仅 UPDATE module='interview' 一行，version+1（knowledge/firstclass 不动）
 *
 * 运行: node scripts/add-interview-tags.js
 */
const mysql = require('mysql2/promise');
const fs = require('fs');

const DB_CONFIG = {
  host: 'rm-bp18fm5u5c7uk47558o.mysql.rds.aliyuncs.com',
  port: 3306,
  user: 'ch17394940726',
  password: 'Ch823147833',
  database: 'fe-journey',
};

function mergeTags(nodes, tagMap, stat) {
  for (const n of nodes) {
    if (n && (n.isLeaf || !n.children)) {
      const tags = tagMap[n.key];
      if (tags && tags.length) {
        n.tags = tags;
        stat.tagged++;
      } else if (n.isLeaf) {
        stat.untagged++;
      }
    }
    if (n && Array.isArray(n.children)) mergeTags(n.children, tagMap, stat);
  }
}

(async () => {
  const tagMap = JSON.parse(
    fs.readFileSync('/tmp/interview-tags.json', 'utf-8'),
  );
  console.log(`载入 ${Object.keys(tagMap).length} 条 key→tags 映射`);

  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const [rows] = await conn.execute(
      "SELECT navData, version FROM nav_config WHERE module = 'interview'",
    );
    if (!rows.length) throw new Error('interview 导航配置不存在');

    let navData = rows[0].navData;
    if (typeof navData === 'string') navData = JSON.parse(navData);

    // 备份当前数据
    fs.writeFileSync(
      '/tmp/interview-navdata-backup.json',
      JSON.stringify(navData, null, 2),
    );
    console.log(
      `当前 version=${rows[0].version}，已备份到 /tmp/interview-navdata-backup.json`,
    );

    const stat = { tagged: 0, untagged: 0 };
    mergeTags(navData, tagMap, stat);
    console.log(`已写入 tags 的叶子: ${stat.tagged}，未匹配到 tags 的叶子: ${stat.untagged}`);

    await conn.execute(
      "UPDATE nav_config SET navData = ?, version = version + 1 WHERE module = 'interview'",
      [JSON.stringify(navData)],
    );
    console.log('✓ interview 导航数据已更新（tags 已合并，version+1）');
  } finally {
    await conn.end();
  }
})().catch(err => {
  console.error('失败:', err.message);
  process.exit(1);
});
