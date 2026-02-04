// x402 Protocol Client
// Based on the x402 protocol spec [[1]](https://github.com/coinbase/x402) [[2]](https://docs.cdp.coinbase.com/x402/welcome),
// x402 uses `HTTP 402` with `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers
//
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import { PaymentIntent } from "../router";

// ─── x402 Types ─────────────────────────────────────────────────────────────

export interface X402PaymentDetails {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

export interface X402SettlementResponse {
  success: boolean;
  txHash?: string;
  network?: string;
  error?: string;
}

// ─── x402 Client ────────────────────────────────────────────────────────────

export class X402Client {
  private facilitatorUrl: string;
  private defaultNetwork: string;
  private defaultAsset: string;
  private timeoutMs: number;

  constructor() {
    const config = getConfig();
    this.facilitatorUrl = config.protocols.x402.facilitator_url;
    this.defaultNetwork = config.protocols.x402.default_network;
    this.defaultAsset = config.protocols.x402.default_asset;
    this.timeoutMs = config.protocols.x402.timeout_ms;
  }

  /**
   * Attempt to access a resource. If 402 is returned, parse payment details.
   */
  async discoverPaymentRequirements(
    resourceUrl: string
  ): Promise<X402PaymentDetails | null> {
    const logger = getLogger();
    logger.debug("x402: Discovering payment requirements", { resourceUrl });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(resourceUrl, {
        method: "GET",
        signal: controller.signal,
      });

      if (response.status !== 402) {
        logger.debug("x402: Resource does not require payment", {
          status: response.status,
        });
        return null;
      }

      // Parse 402 response — payment details are in the response body or headers
      const paymentHeader = response.headers.get("X-PAYMENT");
      if (paymentHeader) {
        const decoded = JSON.parse(
          Buffer.from(paymentHeader, "base64").toString("utf-8")
        );
        return decoded as X402PaymentDetails;
      }

      // Fallback: payment details in response body
      const body = await response.json();
      return body as X402PaymentDetails;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Build a payment payload that can be signed by the wallet (Viem signer).
   */
  buildPaymentPayload(
    intent: PaymentIntent,
    paymentDetails: X402PaymentDetails,
    fromAddress: string,
    signedAuthorization: {
      signature: string;
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    }
  ): X402PaymentPayload {
    return {
      x402Version: 1,
      scheme: paymentDetails.scheme ?? "exact",
      network: intent.network ?? this.defaultNetwork,
      payload: {
        signature: signedAuthorization.signature,
        authorization: {
          from: signedAuthorization.from,
          to: signedAuthorization.to,
          value: signedAuthorization.value,
          validAfter: signedAuthorization.validAfter,
          validBefore: signedAuthorization.validBefore,
          nonce: signedAuthorization.nonce,
        },
      },
    };
  }

  /**
   * Submit payment and access the resource.
   */
  async submitPayment(
    resourceUrl: string,
    paymentPayload: X402PaymentPayload
  ): Promise<{ data: unknown; settlement: X402SettlementResponse }> {
    const logger = getLogger();

    const encodedPayment = Buffer.from(
      JSON.stringify(paymentPayload)
    ).toString("base64");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(resourceUrl, {
        method: "GET",
        headers: {
          "X-PAYMENT": encodedPayment,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`x402 payment rejected: ${response.status} — ${errBody}`);
      }

      // Parse settlement response
      const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE");
      let settlement: X402SettlementResponse = { success: true };

      if (paymentResponseHeader) {
        settlement = JSON.parse(
          Buffer.from(paymentResponseHeader, "base64").toString("utf-8")
        );
      }

      const data = await response.json().catch(() => response.text());

      auditLog("info", "protocol", "x402_payment_submitted", {
        resourceUrl,
        txHash: settlement.txHash,
        success: settlement.success,
      });

      logger.info("x402: Payment submitted successfully", {
        txHash: settlement.txHash,
      });

      return { data, settlement };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Verify a settlement through the facilitator.
   */
  async verifySettlement(
    txHash: string,
    network?: string
  ): Promise<{ verified: boolean; details?: Record<string, unknown> }> {
    const logger = getLogger();
    const url = `${this.facilitatorUrl}/verify`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash,
        network: network ?? this.defaultNetwork,
      }),
    });

    const result = (await response.json()) as {
      verified: boolean;
      details?: Record<string, unknown>;
    };
    logger.debug("x402: Settlement verification", { txHash, verified: result.verified });
    return result;
  }
}
