#!/bin/bash

set -e

# 构建产物目录
export BUILD_DIST=$PWD/.serverless
# 构建开始时间，单位毫秒
export BUILD_START_TIME=$(date +%s%3N)

echo "Building Midway Serverless Application"

# 打印当前目录 cwd
echo "Current Working Directory: $PWD"
# 打印结果目录 BUILD_DIST
echo "Build Directory: $BUILD_DIST"

# 安装当前项目依赖
npm i

# 执行构建
./node_modules/.bin/tsc || return 1
# 生成入口文件
./node_modules/.bin/serverless-yaml-generator || return 1

# 如果 .serverless 文件夹存在，则删除后重新创建
if [ -d "$BUILD_DIST" ]; then
  rm -rf $BUILD_DIST
fi

mkdir $BUILD_DIST

# 拷贝 dist、 *.json、*.yml 到 .serverless 目录
cp -r dist $BUILD_DIST
cp *.yaml $BUILD_DIST 2>/dev/null || :
cp *.json $BUILD_DIST 2>/dev/null || :
# 移动入口文件到 .serverless 目录
mv *.js $BUILD_DIST 2>/dev/null || :

# 进入 .serverless 目录
cd $BUILD_DIST
# 安装线上依赖
npm install --production

echo "Build success"

# 在 .serverless 目录进行部署
s deploy
