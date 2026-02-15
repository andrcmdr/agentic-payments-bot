// Policy Engine
//
import { getConfig, PolicyRules } from "../config/loader";
import { getLogger } from "../logging/logger";
import { auditLog } from "../db/audit";
import { PaymentIntent } from "../protocols/router";
import { getAggregateInWindow } from "../db/transactions";

export interface PolicyViolation {
  rule: string;
  message: string;
  severity: "warning" | "block";
}

export interface PolicyResult {
  allowed: boolean;
  violations: PolicyViolation[];
  requiresHumanConfirmation: boolean;
}

export function evaluatePolicy(
  intent: PaymentIntent,
  amountUsd: number
): PolicyResult {
  const config = getConfig();
  const logger = getLogger();
  const violations: PolicyViolation[] = [];

  if (!config.policy.enabled) {
    return { allowed: true, violations: [], requiresHumanConfirmation: false };
  }

  const rules = config.policy.rules;

  // ── Single transaction limit ──────────────────────────────────────────
  if (amountUsd > rules.single_transaction.max_amount_usd) {
    violations.push({
      rule: "single_transaction.max_amount_usd",
      message: `Amount $${amountUsd.toFixed(2)} exceeds single transaction limit of $${rules.single_transaction.max_amount_usd}`,
      severity: "block",
    });
  }

  // ── Currency restriction ──────────────────────────────────────────────
  if (!rules.allowed_currencies.includes(intent.currency.toUpperCase())) {
    violations.push({
      rule: "allowed_currencies",
      message: `Currency '${intent.currency}' is not in the allowed list: ${rules.allowed_currencies.join(", ")}`,
      severity: "block",
    });
  }

  // ── Blacklist ─────────────────────────────────────────────────────────
  if (rules.blacklist.enabled) {
    const normalized = intent.recipient.toLowerCase();
    if (rules.blacklist.addresses.some((a) => a.toLowerCase() === normalized)) {
      violations.push({
        rule: "blacklist",
        message: `Recipient '${intent.recipient}' is blacklisted`,
        severity: "block",
      });
    }
  }

  // ── Whitelist ─────────────────────────────────────────────────────────
  if (rules.whitelist.enabled && rules.whitelist.addresses.length > 0) {
    const normalized = intent.recipient.toLowerCase();
    if (!rules.whitelist.addresses.some((a) => a.toLowerCase() === normalized)) {
      violations.push({
        rule: "whitelist",
        message: `Recipient '${intent.recipient}' is not in the whitelist`,
        severity: "block",
      });
    }
  }

  // ── Time restrictions ─────────────────────────────────────────────────
  if (rules.time_restrictions.enabled) {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon, ...

    const { start, end } = rules.time_restrictions.allowed_hours;
    if (utcHour < start || utcHour >= end) {
      violations.push({
        rule: "time_restrictions.allowed_hours",
        message: `Current UTC hour ${utcHour} is outside allowed range ${start}–${end}`,
        severity: "block",
      });
    }

    if (!rules.time_restrictions.allowed_days.includes(utcDay)) {
      violations.push({
        rule: "time_restrictions.allowed_days",
        message: `Current day (${utcDay}) is not in allowed days: ${rules.time_restrictions.allowed_days.join(", ")}`,
        severity: "block",
      });
    }
  }

  // ── Time-based aggregate limits ───────────────────────────────────────
  checkWindowLimit(rules.daily, "daily", amountUsd, 1, violations);
  checkWindowLimit(rules.weekly, "weekly", amountUsd, 7, violations);
  checkWindowLimit(rules.monthly, "monthly", amountUsd, 30, violations);

  // ── Result ────────────────────────────────────────────────────────────
  const hasBlockingViolation = violations.some((v) => v.severity === "block");
  const requiresHumanConfirmation =
    hasBlockingViolation && config.policy.require_human_confirmation_on_violation;

  const result: PolicyResult = {
    allowed: !hasBlockingViolation || requiresHumanConfirmation, // can proceed if human confirms
    violations,
    requiresHumanConfirmation,
  };

  if (violations.length > 0) {
    logger.warn("Policy violations detected", {
      count: violations.length,
      violations: violations.map((v) => v.rule),
    });
    auditLog(
      "warn",
      "policy",
      "violations_detected",
      { violations, amountUsd },
    );
  } else {
    logger.info("Policy check passed", { amountUsd });
  }

  return result;
}

function checkWindowLimit(
  windowRule: { max_total_usd: number; max_transaction_count: number },
  windowName: string,
  currentAmountUsd: number,
  windowDays: number,
  violations: PolicyViolation[]
): void {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const windowEnd = now.toISOString();

  const { total_usd, count } = getAggregateInWindow(windowStart, windowEnd);

  if (total_usd + currentAmountUsd > windowRule.max_total_usd) {
    violations.push({
      rule: `${windowName}.max_total_usd`,
      message: `${windowName} total ($${(total_usd + currentAmountUsd).toFixed(2)}) would exceed limit of $${windowRule.max_total_usd}`,
      severity: "block",
    });
  }

  if (count + 1 > windowRule.max_transaction_count) {
    violations.push({
      rule: `${windowName}.max_transaction_count`,
      message: `${windowName} transaction count (${count + 1}) would exceed limit of ${windowRule.max_transaction_count}`,
      severity: "block",
    });
  }
}
