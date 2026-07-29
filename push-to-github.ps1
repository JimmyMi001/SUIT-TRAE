# =============================================================
# 123就出发 — 推送到 GitHub 脚本
# =============================================================
# 用法:
#   1. 在 PowerShell 中执行: Set-ExecutionPolicy -Scope Process Bypass
#   2. 然后: .\push-to-github.ps1
#   3. 提示输入 PAT 时,粘贴到控制台(密码框,不会显示)
# =============================================================

$ErrorActionPreference = 'Stop'

$REPO_OWNER = 'JimmyMi001'  # 你的 GitHub 用户名
$REPO_NAME  = 'SUIT-TRAE-123Lets-GO'   # 仓库名
$BRANCH     = 'main'

Write-Host "`n[1/4] 配置 git 用户..." -ForegroundColor Cyan
git config user.name  "Jimmy"
git config user.email "jimmy@example.com"

Write-Host "[2/4] 检查 remote..." -ForegroundColor Cyan
$remoteUrl = git remote get-url origin 2>$null
if (-not $remoteUrl) {
    Write-Host "  添加 remote: https://github.com/$REPO_OWNER/$REPO_NAME.git" -ForegroundColor Yellow
    git remote add origin "https://github.com/$REPO_OWNER/$REPO_NAME.git"
} else {
    Write-Host "  现有 remote: $remoteUrl" -ForegroundColor Gray
}

Write-Host "[3/4] 确认本地分支为 $BRANCH ..." -ForegroundColor Cyan
$current = git branch --show-current
if ($current -ne $BRANCH) {
    git branch -M $BRANCH
}

Write-Host "[4/4] 推送到 GitHub (会提示输入 PAT)..." -ForegroundColor Cyan
Write-Host "  PAT 输入说明: 粘贴后按回车,字符不会显示`n" -ForegroundColor Gray

# git push 会在第一次推送时弹窗要求输入用户名+密码
# 用户名 = JimmyMi001
# 密码 = 你的 PAT (Personal Access Token,不是 GitHub 登录密码)
git push -u origin $BRANCH

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✓ 推送成功!" -ForegroundColor Green
    Write-Host "  访问: https://github.com/$REPO_OWNER/$REPO_NAME" -ForegroundColor Cyan
} else {
    Write-Host "`n✗ 推送失败,检查上面错误" -ForegroundColor Red
    Write-Host "  常见问题:" -ForegroundColor Yellow
    Write-Host "  - PAT 是否勾选了 'repo' 权限" -ForegroundColor Yellow
    Write-Host "  - 仓库是否已创建(需要先在 GitHub 上建空仓库)" -ForegroundColor Yellow
    Write-Host "  - 网络是否能访问 github.com" -ForegroundColor Yellow
}
