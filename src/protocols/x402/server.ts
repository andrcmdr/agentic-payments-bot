// x402 Server-Side — HTTP 402 Paywall Middleware & Settlement
//
// Exposes this service as an x402-compatible payment provider.
// External agents can pay for protected resources using the standard
// x402 flow: discover (402 + X-PAYMENT header) → pay (X-PAYMENT request header)
// → access (200 + X-PAYMENT-RESPONSE header).
//
import { Router, Request, Response, NextFunction } from "express";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import type {
  X402PaymentDetails,
  X402PaymentPayload,
  X402SettlementResponse,
} from "./client";

// ─── x402 Resource Pricing ──────────────────────────────────────────────────

export interface X402ResourcePricing {
  /** Price in the asset's base unit (e.g. "1000000" for 1 USDC with 6 decimals) */
  maxAmountRequired: string;
  asset: string;
  network: string;
  /** Wallet address that receives payment */
  payTo: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  scheme?: string;
}

// ─── x402 Paywall Middleware ────────────────────────────────────────────────

/**
 * Express middleware that enforces x402 payment on a route.
 *
 * Without `X-PAYMENT` header → HTTP 402 + payment requirements in `X-PAYMENT` response header.
 * With valid `X-PAYMENT` header → verify, settle, attach `X-PAYMENT-RESPONSE`, call next().
 */
export function x402Paywall(pricing: X402ResourcePricing) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const logger = getLogger();
    const paymentHeader = req.headers["x-payment"] as string | undefined;

    if (!paymentHeader) {
      // ── No payment: return 402 with requirements ──────────────────────
      const details: X402PaymentDetails = {
        scheme: pricing.scheme ?? "exact",
        network: pricing.network,
        maxAmountRequired: pricing.maxAmountRequired,
        resource: req.originalUrl,
        description: pricing.description,
        mimeType: pricing.mimeType ?? "application/json",
        payTo: pricing.payTo,
        maxTimeoutSeconds: pricing.maxTimeoutSeconds ?? 60,
        asset: pricing.asset,
      };

      const encoded = Buffer.from(JSON.stringify(details)).toString("base64");

      auditLog("info", "x402_server", "payment_required", {
        route: req.originalUrl,
        amount: pricing.maxAmountRequired,
        asset: pricing.asset,
        ip: req.ip,
      });

      res
        .status(402)
        .set("X-PAYMENT", encoded)
        .json({ error: "Payment Required", accepts: details });
      return;
    }

    // ── Payment header present: decode, verify, settle ──────────────────
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8")
      ) as X402PaymentPayload;

      const settlement = await settlePayment(decoded, pricing);

      if (!settlement.success) {
        auditLog("warn", "x402_server", "settlement_failed", {
          route: req.originalUrl,
          error: settlement.error,
        });

        res.status(402).json({
          error: "Payment settlement failed",
          details: settlement.error,
        });
        return;
      }

      // Attach settlement proof and continue to the resource handler
      const encodedResponse = Buffer.from(
        JSON.stringify(settlement)
      ).toString("base64");
      res.set("X-PAYMENT-RESPONSE", encodedResponse);

      auditLog("info", "x402_server", "payment_settled", {
        route: req.originalUrl,
        txHash: settlement.txHash,
        network: settlement.network,
      });

      logger.info("x402 server: payment settled, granting access", {
        route: req.originalUrl,
        txHash: settlement.txHash,
      });

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("x402 server: invalid payment header", { error: message });
      res.status(400).json({ error: "Invalid X-PAYMENT header", details: message });
    }
  };
}

// ─── Settlement Logic ───────────────────────────────────────────────────────

async function settlePayment(
  payload: X402PaymentPayload,
  pricing: X402ResourcePricing
): Promise<X402SettlementResponse> {
  const config = getConfig();
  const logger = getLogger();

  // In dry-run mode, delegate to the stub
  if (config.dry_run.enabled) {
    const { stubX402Settlement } = await import("../../dry-run/stubs");
    return stubX402Settlement();
  }

  // ── Validate payload fields ───────────────────────────────────────────
  const auth = payload.payload?.authorization;
  if (!auth) {
    return { success: false, error: "Missing authorization in payment payload" };
  }

  if (auth.to.toLowerCase() !== pricing.payTo.toLowerCase()) {
    return {
      success: false,
      error: `Payment 'to' address ${auth.to} does not match expected ${pricing.payTo}`,
    };
  }

  if (BigInt(auth.value) < BigInt(pricing.maxAmountRequired)) {
    return {
      success: false,
      error: `Payment value ${auth.value} is less than required ${pricing.maxAmountRequired}`,
    };
  }

  // Validate time bounds
  const now = Math.floor(Date.now() / 1000);
  if (auth.validAfter && Number(auth.validAfter) > now) {
    return { success: false, error: "Authorization is not yet valid (validAfter)" };
  }
  if (auth.validBefore && Number(auth.validBefore) < now) {
    return { success: false, error: "Authorization has expired (validBefore)" };
  }

  // ── Submit to facilitator for on-chain settlement ─────────────────────
  try {
    const facilitatorUrl = config.protocols.x402.facilitator_url;
    const response = await fetch(`${facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: payload.payload,
        network: payload.network,
        scheme: payload.scheme,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: `Facilitator rejected settlement: ${response.status} ${body}` };
    }

    const result = (await response.json()) as {
      txHash: string;
      network: string;
    };

    return {
      success: true,
      txHash: result.txHash,
      network: result.network,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("x402 server: facilitator settlement error", { error: msg });
    return { success: false, error: `Settlement error: ${msg}` };
  }
}

// ─── Standalone x402 API Router ─────────────────────────────────────────────

/**
 * Express router with x402 management endpoints:
 * - GET  /x402/pricing           — list all registered resource prices
 * - POST /x402/verify            — verify a settlement tx hash
 */
export function createX402Router(
  registeredPricing: Map<string, X402ResourcePricing>
): Router {
  const router = Router();

  // List all registered x402-priced resources
  router.get("/pricing", (_req: Request, res: Response) => {
    const entries = Array.from(registeredPricing.entries()).map(
      ([route, pricing]) => ({ route, ...pricing })
    );
    res.json({ resources: entries });
  });

  // Verify a settlement by tx hash
  router.post("/verify", async (req: Request, res: Response) => {
    const { txHash, network } = req.body as {
      txHash?: string;
      network?: string;
    };

    if (!txHash) {
      res.status(400).json({ error: "Missing txHash" });
      return;
    }

    const config = getConfig();

    if (config.dry_run.enabled) {
      res.json({ verified: true, dryRun: true });
      return;
    }

    try {
      const facilitatorUrl = config.protocols.x402.facilitator_url;
      const response = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash,
          network: network ?? config.protocols.x402.default_network,
        }),
      });

      const result = (await response.json()) as {
        verified: boolean;
        details?: Record<string, unknown>;
      };
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Facilitator error: ${msg}` });
    }
  });

  return router;
}
