import type { Vendor } from "./vendor.js";

type SubprocessKind = Vendor | "agent-browser";

const BASE_ENV_NAMES = new Set([
  "ALL_PROXY",
  "APPDATA",
  "BROWSER",
  "CI",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COLORTERM",
  "ComSpec",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const BASE_ENV_PREFIXES = ["LC_", "QAGENT_", "XDG_"];

const VENDOR_ENV_PREFIXES: Record<SubprocessKind, string[]> = {
  "agent-browser": [],
  claude: ["ANTHROPIC_", "AWS_", "GOOGLE_", "GOOGLE_CLOUD_", "VERTEX_"],
  codex: ["AZURE_OPENAI_", "OLLAMA_", "OPENAI_"],
};

const CODEX_SHELL_ENV_INCLUDE_ONLY = [
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_SOCKET_DIR",
  "ALL_PROXY",
  "BROWSER",
  "CI",
  "COLORTERM",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "RESULT_PATH",
  "SCREENSHOT_DIR",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function shouldIncludeEnvKey(key: string, kind: SubprocessKind): boolean {
  if (BASE_ENV_NAMES.has(key)) {
    return true;
  }

  if (BASE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return true;
  }

  return VENDOR_ENV_PREFIXES[kind].some((prefix) => key.startsWith(prefix));
}

export function buildSubprocessEnv(
  kind: SubprocessKind,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && shouldIncludeEnvKey(key, kind)) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }

    env[key] = value;
  }

  return env;
}

export function getCodexShellEnvironmentIncludeOnly(): string[] {
  return [...CODEX_SHELL_ENV_INCLUDE_ONLY];
}
