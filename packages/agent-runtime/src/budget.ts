import { BudgetSchema, PricingSchema, parse, type Budget, type CancelReason, type Pricing, type Usage } from "@pi-workbench/protocol";

export class BudgetLedger {
  readonly budget: Budget;
  readonly pricing: Pricing;
  private used: Usage;
  constructor(budget: Budget, pricing: Pricing) {
    this.budget = structuredClone(parse(BudgetSchema, budget));
    this.pricing = structuredClone(parse(PricingSchema, pricing));
    this.used = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0, pricingVersion: pricing.version };
  }
  snapshot(): Usage { return { ...this.used }; }
  exhausted(): CancelReason | undefined {
    if (this.used.totalTokens >= this.budget.maxTokens) return "token_limit";
    if (this.used.estimatedCostUsd >= this.budget.maxCostUsd) return "cost_limit";
    return undefined;
  }
  modelCall(): CancelReason | undefined {
    const reason = this.exhausted();
    if (reason) return reason;
    if (this.used.modelCalls >= this.budget.maxModelCalls) return "call_limit";
    this.used.modelCalls++;
    return undefined;
  }
  toolCall(): CancelReason | undefined {
    const reason = this.exhausted();
    if (reason) return reason;
    if (this.used.toolCalls >= this.budget.maxToolCalls) return "tool_limit";
    this.used.toolCalls++;
    return undefined;
  }
  record(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
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
