// KMS Provider Factory
//
// Selects and instantiates the active KMS provider based on configuration.
// Provider hierarchy:
//   1. aws-kms         — AWS KMS (production cloud)
//   2. os-keyring      — OS native keyring via @aspect-build/keytar
//   3. dbus-secret     — Linux Secret Service via dbus-next (pure JS)
//   4. gpg             — GnuPG encryption for headless Linux
//   5. local-aes       — Local AES-256-GCM (dry-run / fallback)

import type { KmsProvider } from "./provider";
import { getConfig } from "../config/loader";
import { getLogger } from "../logging/logger";

let _provider: KmsProvider | null = null;

/**
 * Get the configured KMS provider. Lazily instantiated and cached.
 */
export async function getKmsProvider(): Promise<KmsProvider> {
  if (_provider) return _provider;

  const config = getConfig();
  const providerName = config.kms.provider ?? "aws-kms";
  const logger = getLogger();

  logger.info(`Initializing KMS provider: ${providerName}`);

  switch (providerName) {
    case "aws-kms": {
      const { AwsKmsProvider } = await import("./aws-kms-provider");
      _provider = new AwsKmsProvider();
      break;
    }

    case "os-keyring": {
      // On Linux, respect the linux_keyring_backend setting
      if (process.platform === "linux") {
        const backend = config.kms.linux_keyring_backend ?? "keytar";

        if (backend === "dbus-next") {
          logger.info("Linux keyring backend: dbus-next (pure JS, Secret Service API)");
          const { DbusSecretServiceProvider } = await import("./dbus-secret-service-provider");
          _provider = new DbusSecretServiceProvider();
          break;
        }

        // Default: keytar
        logger.info("Linux keyring backend: @aspect-build/keytar (native addon)");
      }

      const { OsKeyringProvider } = await import("./os-keyring-provider");
      _provider = new OsKeyringProvider();
      break;
    }

    case "dbus-secret": {
      const { DbusSecretServiceProvider } = await import("./dbus-secret-service-provider");
      _provider = new DbusSecretServiceProvider();
      break;
    }

    case "gpg": {
      const { GpgProvider } = await import("./gpg-provider");
      _provider = new GpgProvider();
      break;
    }

    case "local-aes": {
      const { LocalAesProvider } = await import("./local-aes-provider");
      _provider = new LocalAesProvider();
      break;
    }

    default:
      throw new Error(
        `Unknown KMS provider: '${providerName}'. ` +
          `Supported: aws-kms, os-keyring, dbus-secret, gpg, local-aes`
      );
  }

  logger.info(`KMS provider initialized: ${_provider.name}`);
  return _provider;
}

/**
 * Reset the cached provider (for testing or config reload).
 */
export function resetKmsProvider(): void {
  _provider = null;
}
