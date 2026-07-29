#!/usr/bin/env node
// =============================================================
// 123 就出发 — 首次启动引导
// =============================================================
// 职责:
//   1. 检查 Node.js 版本
//   2. 如果 .env 不存在,从 .env.example 复制
//   3. 检查密钥是否还是占位符,提示用户填写
//   4. 如果 node_modules 缺失,自动 npm install
// =============================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline     = require('readline');

const ROOT       = path.resolve(__dirname, '..');
const ENV_FILE   = path.join(ROOT, '.env');
const ENV_EXAMPLE= path.join(ROOT, '.env.example');
const NODE_MOD   = path.join(ROOT, 'node_modules');

const C_GREEN  = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_RED    = '\x1b[31m';
const C_BLUE   = '\x1b[34m';
const C_BOLD   = '\x1b[1m';
const C_RESET  = '\x1b[0m';

function log(icon, msg, color = '') {
  console.log(`${color}${icon}${C_RESET} ${msg}`);
}

function header(title) {
  console.log('');
  console.log(`${C_BOLD}${C_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}`);
  console.log(`${C_BOLD}${C_BLUE}  ${title}${C_RESET}`);
  console.log(`${C_BOLD}${C_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}`);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  header('123 就出发 — 首次启动引导');

  // ----- 1. Node 版本检查 -----
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0], 10);
  if (major < 18) {
    log('❌', `当前 Node.js 版本: ${nodeVer}`, C_RED);
    log('   ', '本项目需要 Node.js 18 或更高版本', C_RED);
    log('   ', '下载地址: https://nodejs.org/', C_YELLOW);
    process.exit(1);
  } else {
    log('✅', `Node.js ${nodeVer} (满足要求 ≥18)`, C_GREEN);
  }

  // ----- 2. .env 检查 -----
  if (!fs.existsSync(ENV_FILE)) {
    if (fs.existsSync(ENV_EXAMPLE)) {
      fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
      log('📄', '已从 .env.example 复制生成 .env', C_GREEN);
      log('   ', '接下来请编辑 .env 填入你的 API 密钥', C_YELLOW);
    } else {
      log('❌', '.env.example 模板不存在,无法初始化 .env', C_RED);
      process.exit(1);
    }
  } else {
    log('✅', '.env 已存在', C_GREEN);
  }

  // ----- 3. 密钥占位符检查 -----
  const envContent = fs.readFileSync(ENV_FILE, 'utf8');
  const amapMatch    = envContent.match(/^\s*AMAP_KEY\s*=\s*(.*?)\s*$/m);
  const deepseekMatch= envContent.match(/^\s*DEEPSEEK_KEY\s*=\s*(.*?)\s*$/m);

  const amapKey     = amapMatch ? amapMatch[1].trim() : '';
  const deepseekKey = deepseekMatch ? deepseekMatch[1].trim() : '';

  const amapOK     = amapKey     && amapKey     !== 'your_amap_key_here';
  const deepseekOK = deepseekKey && deepseekKey !== 'your_deepseek_key_here';

  if (amapOK && deepseekOK) {
    log('✅', 'AMAP_KEY 和 DEEPSEEK_KEY 已配置', C_GREEN);
  } else {
    log('⚠️ ', '检测到密钥未填写:', C_YELLOW);
    if (!amapOK)     log('   ', '• AMAP_KEY     缺失或仍为占位符', C_YELLOW);
    if (!deepseekOK) log('   ', '• DEEPSEEK_KEY 缺失或仍为占位符', C_YELLOW);
    console.log('');
    log('📝', '请按以下步骤获取密钥:', C_BLUE);
    console.log('');
    console.log('   1) 高德地图 API Key:');
    console.log('      https://lbs.amap.com/dev/key/app');
    console.log('      (注册 → 创建应用 → 添加 Key → 选 "Web 服务" 类型)');
    console.log('');
    console.log('   2) DeepSeek API Key:');
    console.log('      https://platform.deepseek.com/api_keys');
    console.log('      (注册 → API Keys → 创建新 Key)');
    console.log('');
    log('   ', `编辑文件: ${ENV_FILE}`, C_YELLOW);

    const ans = await ask(`\n${C_BOLD}是否仍然启动? (y/N)${C_RESET} `);
    if (!/^y(es)?$/i.test(ans)) {
      log('👋', '已取消,请先编辑 .env 后再次启动', C_YELLOW);
      process.exit(0);
    }
    log('🚀', '继续启动(部分功能可能不可用)...', C_YELLOW);
  }

  // ----- 4. node_modules 检查 -----
  if (!fs.existsSync(NODE_MOD)) {
    header('安装依赖 (首次启动需要 1-2 分钟)');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
      log('✅', '依赖安装完成', C_GREEN);
    } catch (e) {
      log('❌', '依赖安装失败,请检查网络或手动执行 npm install', C_RED);
      process.exit(1);
    }
  } else {
    log('✅', '依赖已安装', C_GREEN);
  }

  log('🎉', '准备就绪', C_GREEN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
