// Local AES-256 encryption (no KMS)
//
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../config/loader";
import { getLogger } from "../logging/logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Resolve the dry-run encryption key from the environment.
 * If the key does not exist and we are in dry-run mode, generate one
 * and persist it to `.env` in the project root for subsequent runs.
 */
export function resolveDryRunEncryptionKey(): Buffer {
  const config = getConfig();
  const envVar = config.dry_run.encryption_key_env;
  const logger = getLogger();

  let hexKey = process.env[envVar];

  if (!hexKey || hexKey.length === 0) {
    logger.warn(
      `dry-run: Encryption key not found in env var '${envVar}'. Generating a new one.`
    );
    const generated = crypto.randomBytes(32);
    hexKey = generated.toString("hex");

    // Persist to .env so subsequent runs reuse the same key
    const envFilePath = path.resolve(process.cwd(), ".env");
    const line = `${envVar}=${hexKey}\n`;

    if (fs.existsSync(envFilePath)) {
      const content = fs.readFileSync(envFilePath, "utf-8");
      if (!content.includes(`${envVar}=`)) {
        fs.appendFileSync(envFilePath, line);
        logger.info(`dry-run: Appended generated key to ${envFilePath}`);
      }
    } else {
      fs.writeFileSync(envFilePath, line);
      logger.info(`dry-run: Created ${envFilePath} with generated key`);
    }

    // Also set it in the current process so the rest of the run can use it
    process.env[envVar] = hexKey;
  }

  if (hexKey.length !== 64) {
    throw new Error(
      `dry-run: Encryption key in '${envVar}' must be exactly 64 hex characters (256 bits). Got ${hexKey.length}.`
    );
  }

  return Buffer.from(hexKey, "hex");
}

/**
 * Encrypt plaintext using AES-256-GCM with the dry-run local key.
 * Returns a Buffer: [IV (16 bytes) | authTag (16 bytes) | ciphertext].
 */
export function dryRunEncrypt(plaintext: string): Buffer {
  const key = resolveDryRunEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer produced by `dryRunEncrypt`.
 */
export function dryRunDecrypt(blob: Buffer): string {
  const key = resolveDryRunEncryptionKey();

  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}
