/** Render {{path.to.value|fallback}} placeholders. Missing values use the fallback or ''. */
export function render(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)(?:\|([^}]*))?\s*\}\}/g, (_m, path: string, fallback?: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), data);
    if (value === undefined || value === null || value === '') return fallback ?? '';
    return String(value);
  }).replace(/[ \t]{2,}/g, ' ').trim();
}
