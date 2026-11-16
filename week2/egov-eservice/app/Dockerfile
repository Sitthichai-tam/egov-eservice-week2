# e-Service กลางของเทศบาลนครตัวอย่าง · Node 22 (ใช้ node:sqlite ในตัว ไม่ต้องคอมไพล์ native)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
