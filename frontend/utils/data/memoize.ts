export interface MemoizedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  cache: Map<string, ReturnType<T>>;
}

/**
 * Memoize a function using a Map cache.
 * Optional resolver produces the cache key from arguments;
 * defaults to using the first argument as the key.
 */
export function memoize<T extends (...args: any[]) => any>(
  func: T,
  resolver?: (...args: Parameters<T>) => string,
): MemoizedFunction<T> {
  const cache = new Map<string, ReturnType<T>>();

  const memoized = ((...args: Parameters<T>): ReturnType<T> => {
    const key = resolver ? resolver(...args) : String(args[0]);

    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const result = func(...args);
    cache.set(key, result);
    return result;
  }) as MemoizedFunction<T>;

  memoized.cache = cache;

  return memoized;
}
