// =============================================================
// 加载加密的 .env 文件
// =============================================================
// 优先级:
//   1) 如果存在明文 .env,直接用 dotenv 加载
//   2) 否则尝试解密 .env.enc (需要 .env.keys 或 ENV_MASTER_KEY)
//
// 这样本地开发可以用明文 .env (已在 .gitignore),
// 部署平台 (Render) 可以用密文 + 环境变量传入的主密钥
// =============================================================

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config(); // 先尝试 .env

// 如果 AMAP_KEY/DEEPSEEK_KEY 已经被 dotenv 加载,直接返回
if (process.env.AMAP_KEY && process.env.AMAP_KEY !== 'your_amap_key_here') return;
if (process.env.DEEPSEEK_KEY && process.env.DEEPSEEK_KEY !== 'your_deepseek_key_here') return;

const ROOT = path.resolve(__dirname, '..');
const ENV_ENC_PATH = path.join(ROOT, '.env.enc');
const KEY_PATH     = path.join(ROOT, '.env.keys');

if (!fs.existsSync(ENV_ENC_PATH)) return; // 没有密文就放弃,交给原 dotenv

const masterKey = process.env.ENV_MASTER_KEY
  || (fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8').trim() : null);

if (!masterKey) {
  console.warn('[env-loader] .env.enc 存在但未提供主密钥 (ENV_MASTER_KEY 或 .env.keys)');
  return;
}

try {
  const buf = Buffer.from(fs.readFileSync(ENV_ENC_PATH, 'utf8'), 'base64');
  const salt = buf.subarray(0, 16);
  const iv   = buf.subarray(16, 32);
  const enc  = buf.subarray(32);
  const key  = crypto.pbkdf2Sync(masterKey, salt, 100_000, 32, 'sha256');
  const dec  = Buffer.concat([
    crypto.createDecipheriv('aes-256-cbc', key, iv).update(enc),
    crypto.createDecipheriv('aes-256-cbc', key, iv).final()
  ]).toString('utf8');

  // 解析并写入 process.env
  for (const line of dec.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  console.log('[env-loader] 已从 .env.enc 解密加载环境变量');
} catch (e) {
  console.error('[env-loader] 解密失败:', e.message);
}
