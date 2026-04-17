// Protocol Router (AI Output Parser)
//
import { z } from "zod";
import { getConfig } from "../config/loader";
import { getLogger } from "../logging/logger";
import { auditLog } from "../db/audit";

// ─── Payment Intent Schema ──────────────────────────────────────────────────
//
// `protocol` — a metadata tag indicating the payment's conceptual protocol:
//   • "x402" — onchain / stablecoin / crypto payment flavour
//   • "ap2"  — agent-mediated / mandate-based payment flavour
//
// `gateway` — the actual execution backend used to move money:
//   • "viem"       — direct on-chain ETH/ERC-20 transfer via Viem
//   • "stripe"     — Stripe Payment Intents
//   • "paypal"     — PayPal Orders API
//   • "visa"       — Visa Direct Push Payments
//   • "mastercard" — Mastercard Send API
//   • "googlepay"  — Google Pay token processing
//   • "applepay"   — Apple Pay token processing
//   • "x402"       — outbound x402 client (pay for an external x402-protected resource)
//   • "ap2"        — outbound AP2 client (submit a mandate to an external AP2 service)
//
// The `protocol` tag does NOT determine the execution path — `gateway` does.
// When `gateway` is omitted, the router auto-detects from currency and recipient.

export const PaymentIntentSchema = z.object({
  protocol: z.enum(["x402", "ap2"]),
  action: z.literal("pay"),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a decimal string"),
  currency: z.string(),
  recipient: z.string().min(1),
  network: z.string().optional().nullable(),
  gateway: z
    .enum([
      "viem",
      "visa",
      "mastercard",
      "paypal",
      "stripe",
      "googlepay",
      "applepay",
      "x402",
      "ap2",
    ])
    .optional()
    .nullable(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;

// ─── AI Output Parser ───────────────────────────────────────────────────────

/**
 * Extracts a JSON payment intent from free-form AI output text.
 * Looks for a JSON object containing the `"protocol"` and `"action"` fields.
 */
export function parsePaymentIntentFromAIOutput(
  aiOutput: string
): PaymentIntent | null {
  const logger = getLogger();

  // Try to find JSON block in the output
  const jsonPatterns = [
    /```json\s*([\s\S]*?)```/,       // fenced code block
    /```\s*([\s\S]*?)```/,            // generic code block
    /(\{[\s\S]*?"protocol"[\s\S]*?\})/,  // raw JSON with protocol field
  ];

  for (const pattern of jsonPatterns) {
    const match = aiOutput.match(pattern);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const validated = PaymentIntentSchema.parse(parsed);
        logger.info("Parsed payment intent from AI output", {
          protocol: validated.protocol,
          amount: validated.amount,
          currency: validated.currency,
        });
        return validated;
      } catch {
        // try next pattern
      }
    }
  }

  // Try the entire output as JSON
  try {
    const parsed = JSON.parse(aiOutput.trim());
    return PaymentIntentSchema.parse(parsed);
  } catch {
    logger.debug("No valid payment intent found in AI output");
    return null;
  }
}

// ─── Protocol Router ────────────────────────────────────────────────────────

/**
 * paymentType determines the execution branch in index.ts:
 *   "web3" → sendEth / sendErc20 (direct on-chain via Viem)
 *   "web2" → executeWeb2Payment (Stripe / PayPal / Visa / MC / GPay / APay)
 *   "x402" → X402Client (outbound x402 client — discover → sign → pay → access)
 *   "ap2"  → AP2Client  (outbound AP2 client — mandate → sign → cred → submit)
 */
export type ProtocolRoute = {
  protocol: "x402" | "ap2";
  paymentType: "web3" | "web2" | "x402" | "ap2";
  gateway: string;
};

/**
 * Decides which execution backend to use based on the parsed intent.
 *
 * Resolution order:
 * 1. Explicit `gateway` field → deterministic routing.
 * 2. URL-shaped `recipient` + matching `protocol` → protocol client gateway.
 * 3. Crypto currency or x402 protocol hint → web3/viem.
 * 4. Fallback → web2/stripe.
 *
 * Gateway values:
 *   - "viem"         → direct web3 (Viem ETH/ERC-20)
 *   - "stripe", "paypal", "visa", "mastercard", "googlepay", "applepay" → web2
 *   - "x402"         → remote x402 resource payment (client)
 *   - "ap2"          → remote AP2 mandate payment (client)
 */
export function routePaymentIntent(intent: PaymentIntent): ProtocolRoute {
  const config = getConfig();
  const logger = getLogger();

  // Determine payment type
  let paymentType: ProtocolRoute["paymentType"];
  let gateway: string;

  if (intent.gateway) {
    // ── Explicit gateway: deterministic routing ─────────────────────────
    gateway = intent.gateway;
    switch (gateway) {
      case "viem":
        paymentType = "web3";
        break;
      case "x402":
        paymentType = "x402";
        break;
      case "ap2":
        paymentType = "ap2";
        break;
      default:
        // stripe, paypal, visa, mastercard, googlepay, applepay
        paymentType = "web2";
        break;
    }
  } else {
    // ── Auto-detection ──────────────────────────────────────────────────
    const isUrl =
      intent.recipient.startsWith("http://") ||
      intent.recipient.startsWith("https://");

    if (isUrl && intent.protocol === "x402") {
      // URL recipient + x402 protocol → outbound x402 client
      paymentType = "x402";
      gateway = "x402";
    } else if (isUrl && intent.protocol === "ap2") {
      // URL recipient + ap2 protocol → outbound AP2 client
      paymentType = "ap2";
      gateway = "ap2";
    } else {
      // Currency / protocol heuristic
      const cryptoCurrencies = ["USDC", "ETH", "WETH", "DAI", "USDT"];
      if (
        intent.protocol === "x402" ||
        cryptoCurrencies.includes(intent.currency.toUpperCase())
      ) {
        paymentType = "web3";
        gateway = "viem";
      } else {
        paymentType = "web2";
        gateway = "stripe"; // default web2 gateway
      }
    }
  }

  // ── Validate protocol toggles ────────────────────────────────────────
  if (intent.protocol === "x402" && !config.protocols.x402.enabled) {
    throw new Error("x402 protocol is disabled in configuration");
  }
  if (intent.protocol === "ap2" && !config.protocols.ap2.enabled) {
    throw new Error("AP2 protocol is disabled in configuration");
  }

  const route: ProtocolRoute = { protocol: intent.protocol, paymentType, gateway };

  logger.info("Routed payment intent", route);
  auditLog("info", "protocol", "intent_routed", route as unknown as Record<string, unknown>);

  return route;
}
