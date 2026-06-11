/**
 * 配置校验模块
 * 启动时检查环境变量，给出清晰的提示
 */

function validateConfig() {
  const warnings = [];
  const errors = [];

  // SMTP 配置（邮件功能需要）
  const smtpFields = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_TO"];
  const smtpMissing = smtpFields.filter(f => !process.env[f]);
  if (smtpMissing.length > 0 && smtpMissing.length < smtpFields.length) {
    warnings.push("SMTP 配置不完整，缺少: " + smtpMissing.join(", ") + "。邮件功能将不可用");
  }

  // LLM 配置（AI 分析需要）
  const llmFields = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"];
  const llmMissing = llmFields.filter(f => !process.env[f]);
  if (llmMissing.length > 0 && llmMissing.length < llmFields.length) {
    warnings.push("LLM 配置不完整，缺少: " + llmMissing.join(", ") + "。AI 分析将跳过");
  }

  // Telegram 配置
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    // 不是错误，只是可选功能
  }

  // Web 安全
  if (!process.env.WEB_AUTH_TOKEN) {
    warnings.push("未设置 WEB_AUTH_TOKEN，Web API 写操作无鉴权保护。建议在 .env 中配置");
  }

  // 打印结果
  if (warnings.length > 0) {
    console.log("[配置] " + warnings.length + " 条警告:");
    warnings.forEach(w => console.log("  ⚠️  " + w));
  }

  return { warnings, errors };
}

module.exports = { validateConfig };
