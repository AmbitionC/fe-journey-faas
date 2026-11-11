# 考公职位筛选器数据（杭州镜像）

前端仓 `front-end-journey/public/data/civil/` 的 gzip 副本，由 `GET /civil/data?name=positions|scores&v=<版本>` 下发。
大陆访问 Vercel 太慢（职位表曾一直卡在「正在加载」），前端优先从这里取，取不到或版本对不上再回退 Vercel。

**源头在前端仓。** 前端改了这两份 JSON 后，同步更新这里：

```bash
gzip -9 -n -c ../front-end-journey/public/data/civil/guokao-2027.json   > assets/civil/guokao-2027.json.gz
gzip -9 -n -c ../front-end-journey/public/data/civil/guokao-scores.json > assets/civil/guokao-scores.json.gz
```

忘了同步也不会出错数据：前端带的版本号（明文 sha256 前 12 位）对不上时接口回 409，前端回退原文件，只是慢。
