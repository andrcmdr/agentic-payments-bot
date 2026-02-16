// Human Confirmation Feedback Loop
//
import readlineSync from "readline-sync";
import { getLogger } from "../logging/logger";
import { auditLog } from "../db/audit";
import { PolicyViolation } from "./engine";
import { TransactionRecord } from "../db/transactions";

export type ConfirmationChannel = "cli" | "chat" | "web_api";

export interface ConfirmationRequest {
  tx: TransactionRecord;
  violations: PolicyViolation[];
  channel: ConfirmationChannel;
}

export interface ConfirmationResult {
  confirmed: boolean;
  confirmedBy: string;
  reason?: string;
}

/**
 * Request human confirmation via CLI (interactive terminal).
 */
export function requestCliConfirmation(req: ConfirmationRequest): ConfirmationResult {
  const logger = getLogger();

  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║       ⚠️  PAYMENT REQUIRES HUMAN CONFIRMATION     ║");
  console.log("╚════════════════════════════════════════════════════╝\n");
  console.log(`  Transaction ID: ${req.tx.id}`);
  console.log(`  Protocol:       ${req.tx.protocol}`);
  console.log(`  Amount:         ${req.tx.amount} ${req.tx.currency}`);
  console.log(`  Amount (USD):   $${req.tx.amount_usd.toFixed(2)}`);
  console.log(`  Recipient:      ${req.tx.recipient}`);
  console.log(`  Network:        ${req.tx.network ?? "N/A"}`);
  console.log(`  Gateway:        ${req.tx.gateway ?? "N/A"}`);
  console.log("");
  console.log("  Policy Violations:");
  for (const v of req.violations) {
    console.log(`    ❌ [${v.rule}] ${v.message}`);
  }
  console.log("");

  const answer = readlineSync.question(
    '  Do you want to proceed? (yes/no): '
  );
  const confirmed = answer.trim().toLowerCase() === "yes";
  let reason: string | undefined;

  if (!confirmed) {
    reason =
      readlineSync.question("  Reason for rejection (optional): ") || undefined;
  }

  const result: ConfirmationResult = {
    confirmed,
    confirmedBy: "human/cli",
    reason,
  };

  auditLog(
    confirmed ? "info" : "warn",
    "policy",
    confirmed ? "human_confirmed" : "human_rejected",
    {
      tx_id: req.tx.id,
      violations: req.violations.map((v) => v.rule),
      reason,
    },
    { tx_id: req.tx.id, actor: "human" }
  );

  logger.info("Human confirmation result", {
    tx_id: req.tx.id,
    confirmed,
  });

  return result;
}

/**
 * Build a confirmation prompt for the OpenClaw chat channel.
 * Returns a string the agent should present to the user.
 */
export function buildChatConfirmationPrompt(
  req: ConfirmationRequest
): string {
  const violationList = req.violations
    .map((v) => `  - **${v.rule}**: ${v.message}`)
    .join("\n");

  return (
    `⚠️ **Payment Requires Your Confirmation**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| Transaction ID | \`${req.tx.id}\` |\n` +
    `| Protocol | ${req.tx.protocol} |\n` +
    `| Amount | ${req.tx.amount} ${req.tx.currency} ($${req.tx.amount_usd.toFixed(2)} USD) |\n` +
    `| Recipient | \`${req.tx.recipient}\` |\n` +
    `| Gateway | ${req.tx.gateway ?? "auto"} |\n\n` +
    `**Policy Violations:**\n${violationList}\n\n` +
    `Reply **"confirm ${req.tx.id}"** to proceed or **"reject ${req.tx.id}"** to cancel.`
  );
}

/**
 * Parse a chat response for confirmation.
 */
export function parseChatConfirmation(
  message: string,
  txId: string
): ConfirmationResult | null {
  const lower = message.trim().toLowerCase();

  if (lower === `confirm ${txId}` || lower === `confirm ${txId.slice(0, 8)}`) {
    return { confirmed: true, confirmedBy: "human/chat" };
  }

  if (lower === `reject ${txId}` || lower === `reject ${txId.slice(0, 8)}`) {
    const reason = message.includes(" ") ? message.split(" ").slice(2).join(" ") : undefined;
    return { confirmed: false, confirmedBy: "human/chat", reason };
  }

  return null; // not a confirmation response
}

// Pending confirmation store (in-memory, keyed by tx ID)
const _pendingConfirmations = new Map<
  string,
  {
    request: ConfirmationRequest;
    resolve: (result: ConfirmationResult) => void;
  }
>();

/**
 * Register a pending confirmation for web API / chat async flow.
 */
export function registerPendingConfirmation(
  req: ConfirmationRequest
): Promise<ConfirmationResult> {
  return new Promise((resolve) => {
    _pendingConfirmations.set(req.tx.id, { request: req, resolve });
  });
}

/**
 * Resolve a pending confirmation (called from web API or chat handler).
 */
export function resolvePendingConfirmation(
  txId: string,
  confirmed: boolean,
  actor: string,
  reason?: string
): boolean {
  const pending = _pendingConfirmations.get(txId);
  if (!pending) return false;

  pending.resolve({ confirmed, confirmedBy: actor, reason });
  _pendingConfirmations.delete(txId);

  auditLog(
    confirmed ? "info" : "warn",
    "policy",
    confirmed ? "human_confirmed" : "human_rejected",
    { tx_id: txId, actor, reason },
    { tx_id: txId, actor }
  );

  return true;
}

export function getPendingConfirmations(): Array<{
  txId: string;
  request: ConfirmationRequest;
}> {
  return Array.from(_pendingConfirmations.entries()).map(([txId, entry]) => ({
    txId,
    request: entry.request,
  }));
}
