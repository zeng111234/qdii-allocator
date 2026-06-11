# Sync Skill

同步持仓数据到 GitHub Pages，让手机和电脑数据一致。

## 触发条件

用户说以下任意一种：
- 同步
- 同步数据
- 更新页面
- 同步到 GitHub
- sync

## 执行步骤

1. 运行 `node build-pages.js` 构建页面
2. 运行 `node sync.js` 提交并推送
3. 告诉用户手机访问 https://zeng111234.github.io/trade/

## 注意事项

- 如果用户刚买入基金，先确认买入已完成再同步
- 同步后提醒用户 GitHub Actions 会自动部署，等 1-2 分钟刷新页面
