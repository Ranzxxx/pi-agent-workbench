import { BudgetSchema, PricingSchema, parse, type Budget, type CancelReason, type Pricing, type Usage } from "@pi-workbench/protocol";

export class BudgetLedger {
  readonly budget: Budget;
  readonly pricing: Pricing;
  private readonly initial: Usage;
  private readonly initialComplete: boolean;
  private used: Usage;
  private complete = true;
  constructor(budget: Budget, pricing: Pricing, initialUsage?: Usage, initialUsageComplete = true) {
    // 创建时验证并复制配置，避免调用期间外部修改预算或价格表。
    this.budget = structuredClone(parse(BudgetSchema, budget));
    this.pricing = structuredClone(parse(PricingSchema, pricing));
    this.initial = initialUsage ? structuredClone(initialUsage) : {
      modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 0, estimatedCostUsd: 0, pricingVersion: pricing.version,
    };
    this.initialComplete = initialUsageComplete;
    if (this.initial.pricingVersion !== pricing.version) throw new Error("Continuation pricing version does not match the active budget");
    this.used = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0, pricingVersion: pricing.version };
  }
  snapshot(): Usage { return { ...this.used }; }
  get usageComplete(): boolean { return this.complete; }
  markIncomplete(): void { this.complete = false; }
  private total(key: "modelCalls" | "toolCalls" | "totalTokens" | "estimatedCostUsd"): number { return this.initial[key] + this.used[key]; }
  remainingTokens(): number { return Math.max(0, this.budget.maxTokens - this.total("totalTokens")); }
  exhausted(): CancelReason | undefined {
    // Token 与费用限额基于已收到的 usage 判断，不是对在途调用的预付费硬隔离。
    // 不完整的历史 attempt 无法证明费用仍在预算内；继续执行时按费用上限关闭。
    if (!this.initialComplete || !this.complete) return "cost_limit";
    if (this.total("totalTokens") >= this.budget.maxTokens) return "token_limit";
    if (this.total("estimatedCostUsd") >= this.budget.maxCostUsd) return "cost_limit";
    return undefined;
  }
  modelCall(): CancelReason | undefined {
    const reason = this.exhausted();
    if (reason) return reason;
    if (this.total("modelCalls") >= this.budget.maxModelCalls) return "call_limit";
    this.used.modelCalls++;
    return undefined;
  }
  toolCall(): CancelReason | undefined {
    const reason = this.exhausted();
    if (reason) return reason;
    if (this.total("toolCalls") >= this.budget.maxToolCalls) return "tool_limit";
    this.used.toolCalls++;
    return undefined;
  }
  record(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    // 缓存读写分项留存并计入总量；费用按每百万 Token 估算，pricingVersion 随结果保留。
    for (const value of [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid provider usage");
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    const cost = (tokens.input * this.pricing.input + tokens.output * this.pricing.output + tokens.cacheRead * this.pricing.cacheRead + tokens.cacheWrite * this.pricing.cacheWrite) / 1_000_000;
    if (!Number.isSafeInteger(this.used.totalTokens + total) || !Number.isFinite(cost) || this.used.estimatedCostUsd + cost > Number.MAX_SAFE_INTEGER) throw new Error("Provider usage overflow");
    this.used.inputTokens += tokens.input;
    this.used.outputTokens += tokens.output;
    this.used.cacheReadTokens += tokens.cacheRead;
    this.used.cacheWriteTokens += tokens.cacheWrite;
    this.used.totalTokens += total;
    this.used.estimatedCostUsd += cost;
  }
}
