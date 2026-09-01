export const DEFAULT_WORKER_MODEL = {
  provider: "minimax-cn",
  model: "MiniMax-M2.7"
} as const;

export const DEFAULT_QUOTA_FALLBACK_MODEL = {
  provider: "deepseek",
  model: "deepseek-v4-flash"
} as const;

export function isQuotaMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("429") || lower.includes("rate limit") ||
    /(^|[^a-z0-9_])quota([^a-z0-9_]|$)/.test(lower) || lower.includes("too many requests") ||
    lower.includes("insufficient balance") || lower.includes("insufficient credit") ||
    lower.includes("余额不足") || lower.includes("额度不足");
}
