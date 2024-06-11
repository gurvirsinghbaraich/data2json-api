type PromiseExecutor<T> = (
  resolve: (value: T) => void,
  reject: (reason?: any) => void
) => void;

// Retryable promise class for retrying operations.
export class RetryablePromise<T> extends Promise<T> {
  static async retry<T>(
    retries: number,
    executor: PromiseExecutor<T>
  ): Promise<T> {
    return new RetryablePromise<T>(executor).catch((error) => {
      console.error("Retrying due to error:", error);
      return retries > 0
        ? RetryablePromise.retry(retries - 1, executor)
        : Promise.reject(error);
    });
  }
}
