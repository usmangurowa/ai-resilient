import type { ErrorClassification } from './types';

/** One failed attempt against a model in the fallback chain. */
export interface ModelAttempt {
  modelId: string;
  error: unknown;
  classification: ErrorClassification;
}

/**
 * Thrown when every model in the fallback chain failed with a
 * rate-limit or transient error.
 */
export class AllModelsExhaustedError extends Error {
  override readonly name = 'AllModelsExhaustedError';
  readonly attempts: ModelAttempt[];

  constructor(attempts: ModelAttempt[]) {
    const summary = attempts
      .map((a) => `${a.modelId} (${a.classification})`)
      .join(', ');
    super(`All models exhausted after ${attempts.length} attempt(s): ${summary}`);
    this.attempts = attempts;
  }

  static isInstance(error: unknown): error is AllModelsExhaustedError {
    return error instanceof Error && error.name === 'AllModelsExhaustedError';
  }
}
