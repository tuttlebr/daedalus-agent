/**
 * Deep equality comparison for values commonly found in React props
 * (primitives, plain objects, arrays, and React elements).
 */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }

  if (typeof a !== typeof b) return false;

  if (typeof a !== 'object') return false;

  // Handle arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  // Handle Date
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Handle RegExp
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.toString() === b.toString();
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;

  // React elements are equal when they render the same thing. Their `_owner`
  // is the rendering fiber in development builds: alternating, mutually
  // referencing fibers that a structural walk never finishes comparing.
  if ('$$typeof' in objA || '$$typeof' in objB) {
    return (
      objA.$$typeof === objB.$$typeof &&
      objA.type === objB.type &&
      objA.key === objB.key &&
      objA.ref === objB.ref &&
      isEqual(objA.props, objB.props)
    );
  }

  // Handle plain objects
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!isEqual(objA[key], objB[key])) return false;
  }

  return true;
}
