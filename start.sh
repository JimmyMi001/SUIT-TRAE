#!/usr/bin/env bash
# =============================================================
# 123 就出发 — 本地一键启动（自动重启）
# Mac / Linux
# =============================================================
set -e

cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo "  123 就出发 — 本地一键启动（自动重启）"
echo "============================================================"
echo ""

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未检测到 Node.js"
    echo ""
    echo "请先安装 Node.js 18 或更高版本:"
    echo "  - Mac:   brew install node@20   或  https://nodejs.org/"
    echo "  - Linux: sudo apt install nodejs npm  (Ubuntu/Debian)"
    echo "          sudo yum install nodejs npm  (CentOS/RHEL)"
    echo ""
    exit 1
fi

echo "[信息] Node.js 已安装: $(node -v)"
echo ""

# 运行首次启动引导
echo "[信息] 检查环境配置..."
node scripts/setup.js

# 尝试打开浏览器(Mac / Linux 各自)
(sleep 2 && (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null || true)) &

# 自动重启循环
while true; do
    echo ""
    echo "============================================================"
    echo "  启动服务中... http://localhost:3000"
    echo "  按 Ctrl+C 可停止服务"
    echo "  服务异常退出后将自动重启"
    echo "============================================================"
    echo ""

    npm start || true

    echo ""
    echo "[信息] 服务已停止，5 秒后自动重启..."
    echo "[信息] 如要完全退出，请按 Ctrl+C"
    echo ""
    sleep 5
done