# 使用官方 Node.js 18 镜像作为基础镜像（Alpine 版本，轻量）
FROM node:18-alpine

# 安装 sharp 所需的系统依赖
RUN apk add --no-cache \
    vips-dev \
    fftw-dev \
    gcc \
    g++ \
    make \
    libc-dev

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 复制项目所有文件到容器
COPY . .

# 创建 images 和 uploads 目录（运行时会动态创建，但预先定义确保权限正确）
RUN mkdir -p images uploads && chown -R node:node images uploads

# 切换到非 root 用户运行（安全性考虑）
USER node

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
