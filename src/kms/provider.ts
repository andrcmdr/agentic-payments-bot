// KMS Provider Interface
//
// All KMS backends implement this contract. The factory selects the
// active provider based on configuration.

export interface KmsProvider {
  /** Human-readable provider name (for audit/logging). */
  readonly name: string;

  /**
   * Encrypt and store a secret.
   * @returns A storage identifier (UUID or alias).
   */
  store(keyAlias: string, keyType: string, plaintext: string): Promise<string>;

  /**
   * Retrieve and decrypt a secret by alias.
   * @returns The plaintext value. NEVER log this.
   */
  retrieve(keyAlias: string): Promise<string>;

  /**
   * Delete a secret by alias.
   * @returns true if deleted, false if not found.
   */
  delete(keyAlias: string): Promise<boolean>;

  /**
   * List stored key metadata (no secrets).
   */
  list(): Promise<Array<{ alias: string; type: string; storageId: string; createdAt: string }>>;
}
