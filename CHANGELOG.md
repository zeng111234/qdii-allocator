# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-07-13

### Added

- AI问答助手场景识别系统：自动识别"买什么"、"市场情绪"、"持仓分析"等场景
- 市场温度计算函数：基于FactorEngine评分计算市场温度值和等级
- 假设追踪胜率统计函数：统计验证通过/否定，计算胜率
- 外部信号情绪解析函数：分析多空信号数量和情绪总结
- Smart QA单元测试：9个测试用例，覆盖场景识别、数据注入、格式清理

### Changed

- 优化胜率计算公式：排除expired假设，只计算validated/(validated+invalidated)
- 改进navAtCreation回填逻辑：支持向前回填，减少\_needsNavBackfill标记
- 增强AI问答Prompt数据注入：从4类增加到12类（市场温度、假设胜率、外部信号、基金限购等）
- 结构化输出格式要求：针对不同场景提供结构化输出模板
- 清理Daily Brief思维链：移除`<think>`、`<ANALYSIS_BLOCK>`、`<ORDERS_JSON>`等标签

### Fixed

- 修复external-signals-cache.json解析逻辑：支持{data: [...]}格式
- 修复中文引号语法错误：将中文引号替换为英文单引号
- 修复后续收益计算净值查找：支持向前回填，提高计算准确性

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
