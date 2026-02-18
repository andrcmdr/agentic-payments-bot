#!/usr/bin/env node
// CLI Interface
//
import { Command } from "commander";
import { bootstrap, executePayment } from "./index";
import { PaymentIntentSchema, type PaymentIntent } from "./protocols/router";
import { encryptAndStore, retrieveAndDecrypt } from "./kms/aws-kms";
import { listEncryptedKeys, deleteEncryptedKey } from "./db/key-store";
import { queryAuditLog } from "./db/audit";
import { getTransactionById } from "./db/transactions";
import { getDb } from "./db/sqlite";

const program = new Command();

program
  .name("openclaw-payment")
  .description("OpenClaw Agentic Payment Skill — CLI Interface")
  .version("0.2.0")
  .option("-c, --config <path>", "Path to YAML config file", "config/default.yaml");

// ── pay command ─────────────────────────────────────────────────────────────

program
  .command("pay")
  .description("Execute a payment")
  .requiredOption("--protocol <protocol>", "Protocol: x402 or ap2")
  .requiredOption("--amount <amount>", "Payment amount (decimal string)")
  .requiredOption("--currency <currency>", "Currency code (USDC, ETH, USD, EUR)")
  .requiredOption("--to <recipient>", "Recipient address or ID")
  .option("--network <network>", "Network (ethereum, base, polygon, web2)")
  .option("--gateway <gateway>", "Gateway (viem, stripe, paypal, visa, mastercard)")
  .option("--description <desc>", "Payment description")
  .option("--wallet <alias>", "Wallet key alias in key store", "default_wallet")
  .action(async (opts) => {
    const configPath = program.opts().config;
    bootstrap(configPath);

    const intent: PaymentIntent = PaymentIntentSchema.parse({
      protocol: opts.protocol,
      action: "pay",
      amount: opts.amount,
      currency: opts.currency,
      recipient: opts.to,
      network: opts.network ?? null,
      gateway: opts.gateway ?? null,
      description: opts.description,
      metadata: {},
    });

    try {
      const result = await executePayment(intent, "cli", opts.wallet);
      console.log("\n═══════════════════════════════════════");
      if (result.success) {
        console.log("✅ Payment executed successfully!");
        if (result.txHash) console.log(`   TX Hash: ${result.txHash}`);
        if (result.web2Result)
          console.log(`   Transaction ID: ${result.web2Result.transaction_id}`);
      } else {
        console.log("❌ Payment was not executed.");
        if (result.error) console.log(`   Error: ${result.error}`);
      }
      console.log(`   Internal TX ID: ${result.tx.id}`);
      console.log("═══════════════════════════════════════\n");
    } catch (err) {
      console.error("Fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── parse command (parse AI output) ─────────────────────────────────────────

program
  .command("parse")
  .description("Parse a payment intent from AI output text")
  .argument("<text>", "AI output text (or use - for stdin)")
  .action(async (text: string) => {
    const configPath = program.opts().config;
    bootstrap(configPath);

    const { parsePaymentIntentFromAIOutput } = await import("./protocols/router");
    let input = text;

    if (text === "-") {
      input = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
      });
    }

    const intent = parsePaymentIntentFromAIOutput(input);
    if (intent) {
      console.log("Parsed payment intent:");
      console.log(JSON.stringify(intent, null, 2));
    } else {
      console.log("No valid payment intent found in the provided text.");
    }
  });

// ── keys management ─────────────────────────────────────────────────────────

const keysCmd = program.command("keys").description("Manage encrypted keys/tokens");

keysCmd
  .command("store")
  .description("Encrypt and store a key/token via AWS KMS")
  .requiredOption("--alias <alias>", "Key alias")
  .requiredOption("--type <type>", "Key type (web3_private_key, stripe_token, etc.)")
  .requiredOption("--value <value>", "Plaintext value to encrypt")
  .action(async (opts) => {
    bootstrap(program.opts().config);
    const id = await encryptAndStore(opts.alias, opts.type, opts.value);
    console.log(`✅ Key stored with ID: ${id}, alias: ${opts.alias}`);
  });

keysCmd
  .command("list")
  .description("List all encrypted keys (metadata only)")
  .action(() => {
    bootstrap(program.opts().config);
    const keys = listEncryptedKeys();
    if (keys.length === 0) {
      console.log("No encrypted keys stored.");
    } else {
      console.table(keys);
    }
  });

keysCmd
  .command("delete")
  .description("Delete an encrypted key by alias")
  .argument("<alias>", "Key alias")
  .action((alias: string) => {
    bootstrap(program.opts().config);
    const deleted = deleteEncryptedKey(alias);
    console.log(deleted ? `✅ Deleted key: ${alias}` : `❌ Key not found: ${alias}`);
  });

// ── transactions ────────────────────────────────────────────────────────────

program
  .command("tx")
  .description("Look up a transaction by ID")
  .argument("<txId>", "Transaction ID")
  .action((txId: string) => {
    bootstrap(program.opts().config);
    const tx = getTransactionById(txId);
    if (tx) {
      console.log(JSON.stringify(tx, null, 2));
    } else {
      console.log(`Transaction not found: ${txId}`);
    }
  });

// ── audit ───────────────────────────────────────────────────────────────────

program
  .command("audit")
  .description("Query audit log")
  .option("--category <cat>", "Filter by category")
  .option("--tx <txId>", "Filter by transaction ID")
  .option("--since <iso>", "Filter by timestamp (ISO 8601)")
  .option("--limit <n>", "Max results", "50")
  .action((opts) => {
    bootstrap(program.opts().config);
    const entries = queryAuditLog({
      category: opts.category,
      tx_id: opts.tx,
      since: opts.since,
      limit: parseInt(opts.limit, 10),
    });
    if (entries.length === 0) {
      console.log("No audit entries found.");
    } else {
      for (const entry of entries) {
        console.log(JSON.stringify(entry));
      }
    }
  });

program.parse();
