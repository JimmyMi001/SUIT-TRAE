/**
 * Vercel Serverless 入口
 * Vercel 会把 /api/* 路由到 /api/index.js，并把 req/res 注入进来
 */
const app = require('../server');
module.exports = app;
