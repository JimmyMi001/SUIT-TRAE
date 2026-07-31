# =============================================================
# 123 就出发 — Docker 部署配置
# 适用于 雨云 / Sealos / 任意支持 Docker 的平台
# =============================================================
FROM node:18-alpine

# 时区设为北京时间
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

WORKDIR /app

# 只复制依赖文件,利用 Docker 缓存
COPY package.json package-lock.json ./
RUN npm ci --only=production

# 复制全部源码和静态资源
COPY . .

# 创建缓存目录
RUN mkdir -p .cache/maps .cache/weather .cache/routes

EXPOSE 3000

# 首次启动自动生成 .env 模板(如果不存在)
CMD ["sh", "-c", "node scripts/setup.js 2>/dev/null; node server.js"]
