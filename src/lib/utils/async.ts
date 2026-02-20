export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency <= 0) {
    throw new Error("concurrency must be > 0");
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function work(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => work(),
  );

  await Promise.all(workers);
  return results;
}
