const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function isHttpUrl(value: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function assertHttpUrl(value: string, label: string): string {
  if (!isHttpUrl(value)) {
    throw new Error(`${label} must use http or https.`);
  }

  return value;
}
