export const SUPPORTED_VENDORS = ["claude", "codex"] as const;

export type Vendor = (typeof SUPPORTED_VENDORS)[number];

export function parseVendorOption(value: unknown): Vendor | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  return SUPPORTED_VENDORS.includes(normalized as Vendor) ? (normalized as Vendor) : null;
}

export function formatVendorName(vendor: Vendor): string {
  return vendor === "claude" ? "Claude Code" : "Codex";
}

export function getVendorSessionLogFileName(vendor: Vendor): string {
  return `${vendor}-session.log`;
}
