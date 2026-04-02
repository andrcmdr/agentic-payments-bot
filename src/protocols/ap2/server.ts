// AP2 Server-Side — Mandate Issuer, Credential Provider & Payment Processor
//
// Exposes this service as an AP2-compatible payment provider.
// External agents submit mandates, receive credentials, and trigger
// payment execution against our internal payment backends.
//
import { Router, Request, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import { executeWeb2Payment } from "../../payments/web2/gateways";
import { sendEth, sendErc20 } from "../../payments/web3/ethereum";
import type {
  AP2Mandate,
  AP2PaymentMethodData,
  AP2PaymentResult,
} from "./client";
import type { PaymentIntent } from "../router";
import type { Address } from "viem";

export const ap2Router = Router();

// ─── In-Memory Mandate Store ────────────────────────────────────────────────
// In production, mandate state should live in the database.

interface MandateEntry {
  mandate: AP2Mandate;
  status: "accepted" | "signed" | "executed" | "expired" | "rejected";
  created_at: string;
  executed_at?: string;
  transaction_id?: string;
}

const _mandateStore = new Map<string, MandateEntry>();

// ─── Validation ─────────────────────────────────────────────────────────────

const AP2MandateSchema = z.object({
  mandate_id: z.string().min(1),
  version: z.string(),
  intent: z.object({
    action: z.enum(["purchase", "pay", "subscribe"]),
    description: z.string(),
    amount: z.object({
      value: z.string().regex(/^\d+(\.\d+)?$/),
      currency: z.string().min(1),
    }),
    recipient: z.object({
      id: z.string().min(1),
      name: z.string().optional(),
    }),
  }),
  constraints: z.object({
    max_amount: z.string(),
    valid_from: z.string(),
    valid_until: z.string(),
    single_use: z.boolean(),
  }),
  delegator: z.object({
    agent_id: z.string().min(1),
    user_id: z.string().optional(),
  }),
  signature: z.string().optional(),
});

function validateMandateExpiry(mandate: AP2Mandate): string | null {
  if (mandate.constraints?.valid_until) {
    const expiry = new Date(mandate.constraints.valid_until);
    if (expiry < new Date()) {
      return "Mandate has expired";
    }
  }
  if (mandate.constraints?.valid_from) {
    const start = new Date(mandate.constraints.valid_from);
    if (start > new Date()) {
      return "Mandate is not yet valid";
    }
  }
  return null;
}

// ─── POST /mandates — Accept an agent's mandate ────────────────────────────

ap2Router.post("/mandates", (req: Request, res: Response) => {
  const logger = getLogger();

  try {
    const mandate = AP2MandateSchema.parse(req.body) as AP2Mandate;

    // Check expiry
    const expiryError = validateMandateExpiry(mandate);
    if (expiryError) {
      res.status(400).json({ error: expiryError, mandate_id: mandate.mandate_id });
      return;
    }

    // Check for duplicate
    if (_mandateStore.has(mandate.mandate_id)) {
      res.status(409).json({
        error: "Mandate ID already exists",
        mandate_id: mandate.mandate_id,
      });
      return;
    }

    // Store
    _mandateStore.set(mandate.mandate_id, {
      mandate,
      status: "accepted",
      created_at: new Date().toISOString(),
    });

    auditLog("info", "ap2_server", "mandate_accepted", {
      mandate_id: mandate.mandate_id,
      amount: mandate.intent.amount.value,
      currency: mandate.intent.amount.currency,
      agent_id: mandate.delegator.agent_id,
    });

    logger.info("AP2 server: mandate accepted", {
      mandate_id: mandate.mandate_id,
    });

    res.status(201).json({
      mandate_id: mandate.mandate_id,
      status: "accepted",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("AP2 server: mandate validation failed", { error: message });
    res.status(400).json({ error: message });
  }
});

// ─── GET /mandates/:id — Get mandate status ────────────────────────────────

ap2Router.get("/mandates/:mandateId", (req: Request, res: Response) => {
  const entry = _mandateStore.get(req.params.mandateId);
  if (!entry) {
    res.status(404).json({ error: "Mandate not found" });
    return;
  }

  res.json({
    mandate_id: entry.mandate.mandate_id,
    status: entry.status,
    created_at: entry.created_at,
    executed_at: entry.executed_at,
    transaction_id: entry.transaction_id,
  });
});

// ─── POST /sign-mandate — Sign a mandate (credential provider role) ────────

ap2Router.post("/sign-mandate", (req: Request, res: Response) => {
  const logger = getLogger();
  const { mandate } = req.body as { mandate?: AP2Mandate };

  if (!mandate?.mandate_id) {
    res.status(400).json({ error: "Missing mandate in request body" });
    return;
  }

  // In production: verify the delegator's identity, check permissions,
  // and sign the mandate with the server's ECDSA key.
  const signed: AP2Mandate = {
    ...mandate,
    signature: `sig_${Date.now()}_${uuidv4().slice(0, 8)}`,
  };

  // Update store if we have it
  const entry = _mandateStore.get(mandate.mandate_id);
  if (entry) {
    entry.mandate = signed;
    entry.status = "signed";
  }

  auditLog("info", "ap2_server", "mandate_signed", {
    mandate_id: mandate.mandate_id,
  });

  logger.info("AP2 server: mandate signed", {
    mandate_id: mandate.mandate_id,
  });

  res.json({ signed_mandate: signed });
});

// ─── POST /payment-credentials — Issue tokenized credentials ────────────────

ap2Router.post("/payment-credentials", (req: Request, res: Response) => {
  const { mandate_id, payment_method_type } = req.body as {
    mandate_id?: string;
    payment_method_type?: string;
  };

  if (!mandate_id || !payment_method_type) {
    res.status(400).json({
      error: "Missing mandate_id or payment_method_type",
    });
    return;
  }

  const entry = _mandateStore.get(mandate_id);
  if (!entry) {
    res.status(404).json({ error: "Mandate not found" });
    return;
  }

  if (entry.status === "executed") {
    res.status(409).json({ error: "Mandate already executed (single-use)" });
    return;
  }

  // Issue a scoped, tokenized credential for the given payment method
  const credentials: AP2PaymentMethodData = {
    type: payment_method_type as AP2PaymentMethodData["type"],
    details: {
      token: `tok_${mandate_id}_${Date.now()}`,
      scoped_to_mandate: mandate_id,
      max_amount: entry.mandate.constraints.max_amount,
      currency: entry.mandate.intent.amount.currency,
    },
  };

  auditLog("info", "ap2_server", "credentials_issued", {
    mandate_id,
    payment_method_type,
  });

  res.json(credentials);
});

// ─── POST /process-payment — Execute mandate against payment backends ───────

ap2Router.post("/process-payment", async (req: Request, res: Response) => {
  const logger = getLogger();

  try {
    const { mandate, payment_method } = req.body as {
      mandate?: AP2Mandate;
      payment_method?: AP2PaymentMethodData;
    };

    if (!mandate || !payment_method) {
      res.status(400).json({ error: "Missing mandate or payment_method" });
      return;
    }

    // Validate mandate
    const parseResult = AP2MandateSchema.safeParse(mandate);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid mandate",
        details: parseResult.error.issues,
      });
      return;
    }

    // Check expiry
    const expiryError = validateMandateExpiry(mandate);
    if (expiryError) {
      res.status(400).json({
        mandate_id: mandate.mandate_id,
        status: "failed",
        error: expiryError,
      } satisfies AP2PaymentResult);
      return;
    }

    // Check single-use constraint
    const entry = _mandateStore.get(mandate.mandate_id);
    if (entry?.status === "executed" && mandate.constraints.single_use) {
      res.status(409).json({
        mandate_id: mandate.mandate_id,
        status: "failed",
        error: "Mandate already executed (single-use)",
      } satisfies AP2PaymentResult);
      return;
    }

    // Execute against the appropriate backend
    const result = await executeAP2MandatePayment(mandate, payment_method);

    // Update mandate store
    if (entry && result.status === "success") {
      entry.status = "executed";
      entry.executed_at = new Date().toISOString();
      entry.transaction_id = result.transaction_id;
    }

    auditLog(
      result.status === "success" ? "info" : "error",
      "ap2_server",
      "payment_processed",
      {
        mandate_id: mandate.mandate_id,
        status: result.status,
        transaction_id: result.transaction_id,
        payment_method_type: payment_method.type,
      }
    );

    const httpStatus =
      result.status === "success"
        ? 200
        : result.status === "pending"
          ? 202
          : 400;
    res.status(httpStatus).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("AP2 server: payment processing error", { error: message });
    res.status(500).json({
      mandate_id: req.body?.mandate?.mandate_id ?? "unknown",
      status: "failed",
      error: message,
    } satisfies AP2PaymentResult);
  }
});

// ─── List mandates ──────────────────────────────────────────────────────────

ap2Router.get("/mandates", (_req: Request, res: Response) => {
  const entries = Array.from(_mandateStore.entries()).map(
    ([id, entry]) => ({
      mandate_id: id,
      status: entry.status,
      amount: entry.mandate.intent.amount.value,
      currency: entry.mandate.intent.amount.currency,
      agent_id: entry.mandate.delegator.agent_id,
      created_at: entry.created_at,
      executed_at: entry.executed_at,
    })
  );
  res.json({ mandates: entries });
});

// ─── Internal: Execute payment for an AP2 mandate ───────────────────────────

async function executeAP2MandatePayment(
  mandate: AP2Mandate,
  paymentMethod: AP2PaymentMethodData
): Promise<AP2PaymentResult> {
  const config = getConfig();

  // In dry-run mode, use the AP2 stub
  if (config.dry_run.enabled) {
    const { stubAP2Payment } = await import("../../dry-run/stubs");
    const stubIntent: PaymentIntent = {
      protocol: "ap2",
      action: "pay",
      amount: mandate.intent.amount.value,
      currency: mandate.intent.amount.currency,
      recipient: mandate.intent.recipient.id,
      description: mandate.intent.description,
    };
    return stubAP2Payment(stubIntent);
  }

  // Build a PaymentIntent from the mandate for our internal gateways
  const intent: PaymentIntent = {
    protocol: "ap2",
    action: "pay",
    amount: mandate.intent.amount.value,
    currency: mandate.intent.amount.currency,
    recipient: mandate.intent.recipient.id,
    description: mandate.intent.description,
  };

  switch (paymentMethod.type) {
    case "stripe":
    case "paypal":
    case "card": {
      const gateway =
        paymentMethod.type === "card" ? "stripe" : paymentMethod.type;
      const result = await executeWeb2Payment(gateway, intent);
      return {
        mandate_id: mandate.mandate_id,
        status: result.status,
        transaction_id: result.transaction_id,
        receipt: {
          amount: result.amount,
          currency: result.currency,
          timestamp: new Date().toISOString(),
          reference: result.transaction_id,
        },
        error: result.error,
      };
    }
    case "crypto": {
      const network =
        (paymentMethod.details?.network as string) ?? "base";
      const currency = mandate.intent.amount.currency;
      const to = mandate.intent.recipient.id as Address;
      const walletAlias =
        (paymentMethod.details?.wallet_alias as string) ?? "default_wallet";

      try {
        const txResult =
          currency.toUpperCase() === "ETH"
            ? await sendEth(walletAlias, to, mandate.intent.amount.value, network)
            : await sendErc20(
                walletAlias,
                to,
                mandate.intent.amount.value,
                currency,
                network
              );

        return {
          mandate_id: mandate.mandate_id,
          status: "success",
          transaction_id: txResult.txHash,
          receipt: {
            amount: mandate.intent.amount.value,
            currency,
            timestamp: new Date().toISOString(),
            reference: txResult.txHash,
          },
        };
      } catch (err) {
        return {
          mandate_id: mandate.mandate_id,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "bank_transfer":
    default:
      return {
        mandate_id: mandate.mandate_id,
        status: "failed",
        error: `Unsupported payment method type: ${paymentMethod.type}`,
      };
  }
}
