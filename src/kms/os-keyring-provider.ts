// OS Keyring Provider (cross-platform)
//
// Uses @aspect-build/keytar for:
//   - Linux: Secret Service API (GNOME Keyring / KDE Wallet)
//   - macOS: Keychain
//   - Windows: Credential Manager
//
// Falls back to LocalAesProvider if the keyring is unavailable
// (e.g. headless environments without a D-Bus session).

import type { KmsProvider } from "./provider";
import { getLogger } from "../logging/logger";
import { auditLog } from "../db/audit";

const SERVICE_NAME = "openclaw-payments-agent";
const META_SERVICE = `${SERVICE_NAME}:meta`;
const TYPE_SERVICE = `${SERVICE_NAME}:type`;

type KeytarModule = {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
};

export class OsKeyringProvider implements KmsProvider {
  readonly name = "os-keyring";

  private keytar: KeytarModule | null = null;
  private fallback: KmsProvider | null = null;

  private async getKeytar(): Promise<KeytarModule> {
    if (this.keytar) return this.keytar;

    try {
      // Dynamic import to avoid hard dependency
      this.keytar = await import("@aspect-build/keytar") as KeytarModule;

      // Smoke test: attempt a read to verify D-Bus / Keychain is available
      await this.keytar.getPassword(SERVICE_NAME, "__healthcheck__");
    } catch (err) {
      const logger = getLogger();
      logger.warn(
        "OS keyring unavailable (headless or missing D-Bus session). " +
          "Falling back to local-aes provider.",
        { error: err instanceof Error ? err.message : String(err) }
      );
      auditLog("warn", "kms", "os_keyring_fallback_to_local_aes", {
        reason: err instanceof Error ? err.message : String(err),
      });

      // Fallback to local AES
      const { LocalAesProvider } = await import("./local-aes-provider");
      this.fallback = new LocalAesProvider();
      throw err; // rethrow to signal the switch
    }

    return this.keytar;
  }

  private async withFallback<T>(fn: (kt: KeytarModule) => Promise<T>, fallbackFn: () => Promise<T>): Promise<T> {
    if (this.fallback) return fallbackFn();

    try {
      const kt = await this.getKeytar();
      return await fn(kt);
    } catch {
      // If keytar threw during init, fallback is now set
      if (this.fallback) return fallbackFn();
      throw new Error("OS keyring operation failed and no fallback is available");
    }
  }

  async store(keyAlias: string, keyType: string, plaintext: string): Promise<string> {
    return this.withFallback(
      async (kt) => {
        const logger = getLogger();

        await kt.setPassword(SERVICE_NAME, keyAlias, plaintext);
        await kt.setPassword(TYPE_SERVICE, keyAlias, keyType);
        // Store creation timestamp
        await kt.setPassword(META_SERVICE, keyAlias, new Date().toISOString());

        logger.info("Stored key in OS keyring", { keyAlias, keyType });
        auditLog("info", "kms", "key_encrypted_and_stored", {
          keyAlias,
          keyType,
          provider: this.name,
        });

        return keyAlias; // alias IS the identifier in keyring mode
      },
      async () => {
        return this.fallback!.store(keyAlias, keyType, plaintext);
      }
    );
  }

  async retrieve(keyAlias: string): Promise<string> {
    return this.withFallback(
      async (kt) => {
        const secret = await kt.getPassword(SERVICE_NAME, keyAlias);
        if (!secret) {
          throw new Error(`Key '${keyAlias}' not found in OS keyring`);
        }

        getLogger().debug("Retrieved key from OS keyring", { keyAlias });
        auditLog("info", "kms", "key_decrypted", {
          keyAlias,
          provider: this.name,
        });

        return secret;
      },
      async () => {
        return this.fallback!.retrieve(keyAlias);
      }
    );
  }

  async delete(keyAlias: string): Promise<boolean> {
    return this.withFallback(
      async (kt) => {
        const deleted = await kt.deletePassword(SERVICE_NAME, keyAlias);
        await kt.deletePassword(TYPE_SERVICE, keyAlias);
        await kt.deletePassword(META_SERVICE, keyAlias);

        if (deleted) {
          auditLog("warn", "kms", "key_deleted", {
            keyAlias,
            provider: this.name,
          });
        }
        return deleted;
      },
      async () => {
        return this.fallback!.delete(keyAlias);
      }
    );
  }

  async list(): Promise<Array<{ alias: string; type: string; storageId: string; createdAt: string }>> {
    return this.withFallback(
      async (kt) => {
        const creds = await kt.findCredentials(SERVICE_NAME);
        const types = await kt.findCredentials(TYPE_SERVICE);
        const metas = await kt.findCredentials(META_SERVICE);

        const typeMap = new Map(types.map((t) => [t.account, t.password]));
        const metaMap = new Map(metas.map((m) => [m.account, m.password]));

        return creds.map((c) => ({
          alias: c.account,
          type: typeMap.get(c.account) ?? "unknown",
          storageId: `keyring:${c.account}`,
          createdAt: metaMap.get(c.account) ?? "unknown",
        }));
      },
      async () => {
        return this.fallback!.list();
      }
    );
  }
}
