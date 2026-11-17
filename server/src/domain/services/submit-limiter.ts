/**
 * 提交限流：按来源做滑动窗口计数。
 * 生成任务会消耗 LLM 与图片检索额度，接口不能无限制被调用。
 */
export class SubmitLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** limit <= 0 表示不限制；key 一般为请求来源 IP */
  allow(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true;

    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((time) => time > since);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
