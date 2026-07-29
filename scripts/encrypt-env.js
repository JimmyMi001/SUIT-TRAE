// =============================================================
// 密钥加密工具 (基于 dotenvx 思路的本地简化实现)
// =============================================================
//
// 目的:把 .env 里的明文密钥加密成 .env.enc,推送到 GitHub 也没关系
// 解密密钥 .env.keys 单独保管(不要入仓,本地 + Render 平台分发)
//
// 用法:
//   node scripts/encrypt-env.js          # 加密 .env → .env.enc
//   node scripts/encrypt-env.js --dec    # 解密 .env.enc → .env
//   node scripts/encrypt-env.js --genkey # 生成新的 32 字节主密钥
//
// 注意:
//   这是一个对称加密 (AES-256-CBC + 密钥派生),适合"密钥不公开,密文公开"场景
//   生产环境推荐 dotenvx: https://dotenvx.com
// =============================================================

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH     = path.join(ROOT, '.env');
const ENV_ENC_PATH = path.join(ROOT, '.env.enc');
const KEY_PATH     = path.join(ROOT, '.env.keys');

const ALGO = 'aes-256-cbc';
const ITER = 100_000; // PBKDF2 迭代次数

// 用 PBKDF2 把任意长度的主密钥导出为固定 32 字节
function deriveKey(masterKey, salt) {
  return crypto.pbkdf2Sync(masterKey, salt, ITER, 32, 'sha256');
}

function encrypt(plain, masterKey) {
  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(16);
  const key  = deriveKey(masterKey, salt);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([salt, iv, enc]).toString('base64');
}

function decrypt(b64, masterKey) {
  const buf = Buffer.from(b64, 'base64');
  const salt = buf.subarray(0, 16);
  const iv   = buf.subarray(16, 32);
  const enc  = buf.subarray(32);
  const key  = deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function loadKey() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`未找到密钥文件: ${KEY_PATH}`);
    console.error(`请先生成: node scripts/encrypt-env.js --genkey`);
    process.exit(1);
  }
  return fs.readFileSync(KEY_PATH, 'utf8').trim();
}

function genKey() {
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
  console.log(`✓ 已生成主密钥: ${KEY_PATH}`);
  console.log(`⚠ 请妥善保管,并在部署平台(Render)的环境变量中设置:`);
  console.log(`   ENV_MASTER_KEY = ${k}`);
}

function doEncrypt() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`未找到 ${ENV_PATH}`);
    process.exit(1);
  }
  const plain = fs.readFileSync(ENV_PATH, 'utf8');
  const key   = loadKey();
  const enc   = encrypt(plain, key);
  fs.writeFileSync(ENV_ENC_PATH, enc);
  console.log(`✓ 已加密: ${ENV_PATH} → ${ENV_ENC_PATH}`);
  console.log(`  大小: ${plain.length} → ${enc.length} (base64)`);
}

function doDecrypt() {
  if (!fs.existsSync(ENV_ENC_PATH)) {
    console.error(`未找到 ${ENV_ENC_PATH}`);
    process.exit(1);
  }
  const enc   = fs.readFileSync(ENV_ENC_PATH, 'utf8');
  const key   = loadKey();
  const plain = decrypt(enc, key);
  fs.writeFileSync(ENV_PATH, plain, { mode: 0o600 });
  console.log(`✓ 已解密: ${ENV_ENC_PATH} → ${ENV_PATH}`);
}

const arg = process.argv[2];
if      (arg === '--genkey') genKey();
else if (arg === '--dec')    doDecrypt();
else                          doEncrypt();
