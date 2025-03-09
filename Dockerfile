# 构建阶段
FROM alpine:3.19 AS builder

# 安装构建依赖
RUN apk add --no-cache nodejs npm vips-dev fftw-dev gcc g++ make libc-dev

# 设置工作目录
WORKDIR /build

# 复制依赖文件
COPY package*.json ./

# 只安装生产环境依赖
RUN npm ci --only=production

# 运行阶段
FROM alpine:3.19

# 安装运行时所需最小依赖
RUN apk add --no-cache nodejs vips

# 设置工作目录
WORKDIR /app

# 从构建阶段复制依赖
COPY --from=builder /build/node_modules ./node_modules

# 复制应用代码
COPY . .

# 创建必要的目录
RUN mkdir -p images uploads

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
