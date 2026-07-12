# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-07-12

### Added

- 假设数据修复脚本 (`scripts/fix-hypotheses-data.js`)：修复ID碰撞、stats计数器漂移、navAtCreation为null的问题
- 假设类型判断逻辑优化：基于多个因子综合判断（回撤、波动率、夏普比率、近期表现等）
- 为不同假设类型设置不同的验证条件（目标收益、止损、时间周期）

### Changed

- 更新限购数据：修正多个基金的dailyLimit值
- 改进假设引擎：实时重算stats计数器，生成唯一ID（时间戳+随机后缀），从navCache获取基准净值
- 修复脚本路径：使用path.join确保跨平台兼容性
- 改进前端假设类型判断：与后端逻辑保持一致

### Fixed

- 删除重复的假设ID，避免数据不一致
- 标记navAtCreation为null的假设，暂不参与胜率计算
- 修复ESLint错误和回撤因子计算逻辑

## [1.0.0] - 2026-07-10

### Added

- 初始版本发布
- 25维因子评分系统
- 智能动态分配策略
- 假设追踪引擎
- 持仓管理功能
- AI投资助手
- 多智能体辩论模块
- GitHub Pages自动部署
