const BUILTIN_EFFORTS = new Set(['default', 'none', 'low', 'medium', 'high', 'max']);

export function normalizeCustomReasoningEfforts(input: unknown): string[] {
  const text = typeof input === 'string' ? input
    : Array.isArray(input) ? input.filter((value): value is string => typeof value === 'string').join(',') : '';
  return [...new Set(text.split(/[,，;；\r\n]+/)
    .map(value => value.trim()).filter(value => value && !BUILTIN_EFFORTS.has(value)))];
}
