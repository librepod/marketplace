// Kubernetes quantity -> number (cores for CPU, bytes for memory).
// @kubernetes/client-node's quantityToScalar isn't exported from its index.
const FACTORS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

export function parseQuantity(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(n|u|m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(q.trim());
  if (!m) throw new Error(`not a Kubernetes quantity: ${q}`);
  return Number(m[1]) * FACTORS[m[2] ?? ''];
}
