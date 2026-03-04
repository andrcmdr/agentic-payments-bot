// Web2 Payment Gateways API Bindings
//
import Stripe from "stripe";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import { retrieveAndDecrypt } from "../../kms/aws-kms";
import { PaymentIntent } from "../../protocols/router";

// ─── Common Result Type ─────────────────────────────────────────────────────

export interface Web2PaymentResult {
  gateway: string;
  transaction_id: string;
  status: "success" | "pending" | "failed";
  amount: string;
  currency: string;
  receipt_url?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════════════════════════════════════════

let _stripeClient: Stripe | null = null;

async function getStripeClient(): Promise<Stripe> {
  if (!_stripeClient) {
    const apiKey = await retrieveAndDecrypt("stripe_api_key");
    const config = getConfig();
    _stripeClient = new Stripe(apiKey, {
      apiVersion: config.web2.stripe.api_version as Stripe.LatestApiVersion,
    });
  }
  return _stripeClient;
}

export async function stripePayment(
  intent: PaymentIntent
): Promise<Web2PaymentResult> {
  const logger = getLogger();
  logger.info("web2/stripe: Creating payment intent", {
    amount: intent.amount,
    currency: intent.currency,
  });

  const stripe = await getStripeClient();
  const amountCents = Math.round(parseFloat(intent.amount) * 100);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: intent.currency.toLowerCase(),
    description: intent.description ?? "Agentic payment via OpenClaw",
    metadata: {
      protocol: intent.protocol,
      recipient: intent.recipient,
      ...(intent.metadata as Record<string, string>),
    },
    automatic_payment_methods: { enabled: true },
  });

  auditLog("info", "payment", "stripe_intent_created", {
    stripe_id: paymentIntent.id,
    amount: intent.amount,
    currency: intent.currency,
    status: paymentIntent.status,
  });

  return {
    gateway: "stripe",
    transaction_id: paymentIntent.id,
    status: paymentIntent.status === "succeeded" ? "success" : "pending",
    amount: intent.amount,
    currency: intent.currency,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYPAL
// ═══════════════════════════════════════════════════════════════════════════

async function getPayPalAccessToken(): Promise<string> {
  const config = getConfig();
  const clientId = await retrieveAndDecrypt("paypal_client_id");
  const clientSecret = await retrieveAndDecrypt("paypal_secret");

  const response = await fetch(`${config.web2.paypal.base_url}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`PayPal auth failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

export async function paypalPayment(
  intent: PaymentIntent
): Promise<Web2PaymentResult> {
  const logger = getLogger();
  const config = getConfig();

  logger.info("web2/paypal: Creating order", {
    amount: intent.amount,
    currency: intent.currency,
  });

  const accessToken = await getPayPalAccessToken();

  const response = await fetch(`${config.web2.paypal.base_url}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: intent.currency.toUpperCase(),
            value: intent.amount,
          },
          description: intent.description ?? "Agentic payment via OpenClaw",
          payee: {
            email_address: intent.recipient,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`PayPal order creation failed: ${response.status} ${errBody}`);
  }

  const order = (await response.json()) as {
    id: string;
    status: string;
    links: Array<{ rel: string; href: string }>;
  };

  auditLog("info", "payment", "paypal_order_created", {
    order_id: order.id,
    status: order.status,
  });

  const approvalLink = order.links?.find((l) => l.rel === "approve")?.href;

  return {
    gateway: "paypal",
    transaction_id: order.id,
    status: order.status === "COMPLETED" ? "success" : "pending",
    amount: intent.amount,
    currency: intent.currency,
    receipt_url: approvalLink,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VISA (Visa Direct - Push Payments API)
// ═══════════════════════════════════════════════════════════════════════════

export async function visaPayment(
  intent: PaymentIntent
): Promise<Web2PaymentResult> {
  const logger = getLogger();
  const config = getConfig();

  logger.info("web2/visa: Initiating Visa Direct push payment", {
    amount: intent.amount,
    currency: intent.currency,
  });

  const userId = await retrieveAndDecrypt("visa_user_id");
  const password = await retrieveAndDecrypt("visa_password");

  const response = await fetch(
    `${config.web2.visa.base_url}/visadirect/fundstransfer/v1/pushfundstransactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${userId}:${password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        systemsTraceAuditNumber: String(Date.now()).slice(-6),
        retrievalReferenceNumber: String(Date.now()).slice(-12),
        localTransactionDateTime: new Date()
          .toISOString()
          .replace(/[-:T]/g, "")
          .slice(0, 14),
        acquiringBin: "408999",
        acquirerCountryCode: "840",
        senderAccountNumber: intent.metadata?.senderAccount ?? "",
        transactionCurrencyCode: intent.currency === "USD" ? "840" : intent.currency,
        recipientPrimaryAccountNumber: intent.recipient,
        amount: intent.amount,
        businessApplicationId: "AA",
        merchantCategoryCode: "6012",
        senderName: intent.metadata?.senderName ?? "OpenClaw Agent",
        senderAddress: intent.metadata?.senderAddress ?? "N/A",
        senderCity: intent.metadata?.senderCity ?? "San Francisco",
        senderStateCode: "CA",
        senderCountryCode: "840",
        cardAcceptor: {
          name: "OpenClaw Payment Skill",
          terminalId: "OCTERM01",
          idCode: "OCMERCH001",
          address: { country: "USA", zipCode: "94105", county: "06" },
        },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Visa payment failed: ${response.status} ${errBody}`);
  }

  const result = (await response.json()) as {
    transactionIdentifier: string;
    actionCode: string;
    responseCode: string;
  };

  auditLog("info", "payment", "visa_payment_submitted", {
    transactionId: result.transactionIdentifier,
    actionCode: result.actionCode,
  });

  return {
    gateway: "visa",
    transaction_id: result.transactionIdentifier,
    status: result.actionCode === "00" ? "success" : "failed",
    amount: intent.amount,
    currency: intent.currency,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MASTERCARD (Mastercard Send API)
// ═══════════════════════════════════════════════════════════════════════════

export async function mastercardPayment(
  intent: PaymentIntent
): Promise<Web2PaymentResult> {
  const logger = getLogger();
  const config = getConfig();

  logger.info("web2/mastercard: Initiating Mastercard Send payment", {
    amount: intent.amount,
    currency: intent.currency,
  });

  const consumerKey = await retrieveAndDecrypt("mastercard_consumer_key");
  const signingKey = await retrieveAndDecrypt("mastercard_signing_key");

  // Mastercard Send uses OAuth 1.0a; this is a simplified representation.
  // In production, use the official Mastercard SDK or a proper OAuth1 signer.
  const response = await fetch(
    `${config.web2.mastercard.base_url}/send/v1/partners/transfers/payment`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // In production, this would be a proper OAuth1 header:
        Authorization: `OAuth oauth_consumer_key="${consumerKey}"`,
      },
      body: JSON.stringify({
        partnerId: intent.metadata?.partnerId ?? "",
        transferReference: `OC-${Date.now()}`,
        paymentType: "P2M",
        amount: intent.amount,
        currency: intent.currency,
        senderAccountUri: intent.metadata?.senderUri ?? "",
        recipientAccountUri: `pan:${intent.recipient}`,
        fundingSource: "CREDIT",
        transactionPurpose: intent.description ?? "Agentic payment",
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Mastercard payment failed: ${response.status} ${errBody}`);
  }

  const result = (await response.json()) as {
    transferReference: string;
    transactionStatus: string;
    transactionId: string;
  };

  auditLog("info", "payment", "mastercard_payment_submitted", {
    transactionId: result.transactionId,
    status: result.transactionStatus,
  });

  return {
    gateway: "mastercard",
    transaction_id: result.transactionId ?? result.transferReference,
    status: result.transactionStatus === "APPROVED" ? "success" : "pending",
    amount: intent.amount,
    currency: intent.currency,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GATEWAY DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

export async function executeWeb2Payment(
  gateway: string,
  intent: PaymentIntent
): Promise<Web2PaymentResult> {
  // In dry-run mode, use stub responses instead of real API calls
  if (getConfig().dry_run.enabled) {
    const { stubWeb2Payment } = await import("../../dry-run/stubs");
    return stubWeb2Payment(gateway, intent);
  }

  switch (gateway) {
    case "stripe":
      return stripePayment(intent);
    case "paypal":
      return paypalPayment(intent);
    case "visa":
      return visaPayment(intent);
    case "mastercard":
      return mastercardPayment(intent);
    default:
      throw new Error(`Unsupported web2 gateway: ${gateway}`);
  }
}
