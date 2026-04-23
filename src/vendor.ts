export const SUPPORTED_VENDORS = ["claude", "codex"] as const;
export const SUPPORTED_CODEX_SANDBOXES = ["workspace-write", "danger-full-access"] as const;

export type Vendor = (typeof SUPPORTED_VENDORS)[number];
export type CodexSandboxMode = (typeof SUPPORTED_CODEX_SANDBOXES)[number];

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

export function parseCodexSandboxOption(value: unknown): CodexSandboxMode | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  return SUPPORTED_CODEX_SANDBOXES.includes(normalized as CodexSandboxMode) ? (normalized as CodexSandboxMode) : null;
}
