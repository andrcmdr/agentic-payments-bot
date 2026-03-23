// GnuPG Provider
//
// Encrypts/decrypts secrets using gpg2 (GnuPG) with a specified GPG key ID.
// Ideal for headless Linux servers without D-Bus / desktop sessions.
// Stores ciphertext in SQLite (same as AWS KMS provider).

import { execFile } from "child_process";
import type { KmsProvider } from "./provider";
import { getConfig } from "../config/loader";
import { getLogger } from "../logging/logger";
import { auditLog } from "../db/audit";
import {
  storeEncryptedKey,
  getEncryptedKey,
  listEncryptedKeys,
  deleteEncryptedKey,
} from "../db/key-store";

/**
 * Runs `execFile` with data piped to stdin and returns stdout as a Buffer.
 */
function execFileWithInput(
  file: string,
  args: string[],
  input: Buffer,
  maxBuffer = 1024 * 1024
): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: "buffer", maxBuffer }, (error, stdout) => {
      if (error) return reject(error);
      resolve({ stdout: Buffer.from(stdout) });
    });
    child.stdin?.end(input);
  });
}

function getGpgKeyId(): string {
  const config = getConfig();
  const keyId = config.kms.gpg_key_id;
  if (!keyId) {
    throw new Error(
      "GPG provider requires 'kms.gpg_key_id' to be set in configuration. " +
        "Use the fingerprint or email of your GPG key."
    );
  }
  return keyId;
}

function getGpgBinary(): string {
  return getConfig().kms.gpg_binary ?? "gpg2";
}

export class GpgProvider implements KmsProvider {
  readonly name = "gpg";

  async store(keyAlias: string, keyType: string, plaintext: string): Promise<string> {
    const logger = getLogger();
    const gpgKeyId = getGpgKeyId();
    const gpgBin = getGpgBinary();

    logger.debug("Encrypting key via GnuPG", { keyAlias, keyType, gpgKeyId });

    // Encrypt using gpg: read from stdin, output binary
    const { stdout } = await execFileWithInput(
      gpgBin,
      [
        "--batch",
        "--yes",
        "--trust-model", "always",
        "--encrypt",
        "--recipient", gpgKeyId,
        "--armor",   // ASCII-armored for safe SQLite blob storage
      ],
      Buffer.from(plaintext, "utf-8"),
    );

    const ciphertext = Buffer.from(stdout);
    const id = storeEncryptedKey(keyType, keyAlias, ciphertext, `gpg:${gpgKeyId}`);

    auditLog("info", "kms", "key_encrypted_and_stored", {
      keyAlias,
      keyType,
      gpgKeyId,
      provider: this.name,
    });

    return id;
  }

  async retrieve(keyAlias: string): Promise<string> {
    const logger = getLogger();
    const gpgBin = getGpgBinary();

    const record = getEncryptedKey(keyAlias);
    if (!record) {
      throw new Error(`Encrypted key not found for alias '${keyAlias}'`);
    }

    logger.debug("Decrypting key via GnuPG", { keyAlias, keyType: record.key_type });

    // Decrypt using gpg: read ciphertext from stdin
    const { stdout } = await execFileWithInput(
      gpgBin,
      [
        "--batch",
        "--yes",
        "--quiet",
        "--decrypt",
      ],
      record.ciphertext as Buffer,
    );

    auditLog("info", "kms", "key_decrypted", {
      keyAlias,
      keyType: record.key_type,
      provider: this.name,
    });

    return Buffer.from(stdout).toString("utf-8");
  }

  async delete(keyAlias: string): Promise<boolean> {
    return deleteEncryptedKey(keyAlias);
  }

  async list(): Promise<Array<{ alias: string; type: string; storageId: string; createdAt: string }>> {
    return listEncryptedKeys().map((k) => ({
      alias: k.key_alias,
      type: k.key_type,
      storageId: k.id,
      createdAt: k.created_at,
    }));
  }
}
