export interface EmbeddingProvider {
  readonly name: string;
  /** Model identifier sent to the provider — part of the index's identity. */
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderMeta {
  name: string;
  dim: number;
  /**
   * Absent on indexes written before the model was recorded. Their `dim` is
   * also untrustworthy: it was a hardcoded 768, not the measured width.
   */
  model?: string;
}
