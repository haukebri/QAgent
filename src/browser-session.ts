import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { buildSubprocessEnv } from "./subprocess-env.js";

export interface BrowserSession {
  sessionName: string;
  socketDir: string;
}

const AGENT_BROWSER_TIMEOUT_BUFFER_MS = 5_000;

function agentBrowser(
  args: string[],
  sessionName: string,
  socketDir: string,
  opts: {
    globalFlags?: string[];
    startupTimeoutMs: number;
  },
): string {
  try {
    return execFileSync("agent-browser", [...(opts.globalFlags ?? []), "--session", sessionName, ...args], {
      encoding: "utf8",
      timeout: opts.startupTimeoutMs + AGENT_BROWSER_TIMEOUT_BUFFER_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSubprocessEnv("agent-browser", {
        AGENT_BROWSER_SOCKET_DIR: socketDir,
        AGENT_BROWSER_DEFAULT_TIMEOUT: String(opts.startupTimeoutMs),
      }),
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent-browser ${args[0]} failed: ${message}`);
  }
}

export function startBrowserSession(opts: {
  url: string;
  basicAuth?: { username: string; password: string };
  headed?: boolean;
  socketDir: string;
  startupTimeoutMs: number;
}): BrowserSession {
  const sessionName = `qa-${crypto.randomBytes(4).toString("hex")}`;
  const socketDir = path.resolve(opts.socketDir);
  const globalFlags = opts.headed ? ["--headed"] : [];
  mkdirSync(socketDir, { recursive: true });

  // Set HTTP basic auth credentials before navigating
  if (opts.basicAuth) {
    agentBrowser(["set", "credentials", opts.basicAuth.username, opts.basicAuth.password], sessionName, socketDir, {
      globalFlags,
      startupTimeoutMs: opts.startupTimeoutMs,
    });
  }

  // Open the URL — this verifies the site is reachable and starts the browser
  agentBrowser(["open", opts.url], sessionName, socketDir, {
    globalFlags,
    startupTimeoutMs: opts.startupTimeoutMs,
  });

  return { sessionName, socketDir };
}

export function closeBrowserSession(session: BrowserSession): void {
  try {
    execFileSync("agent-browser", ["--session", session.sessionName, "close"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSubprocessEnv("agent-browser", {
        AGENT_BROWSER_SOCKET_DIR: session.socketDir,
      }),
    });
  } catch {
    // Best-effort cleanup; don't fail the run
  }

  try {
    rmSync(session.socketDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; don't fail the run
  }
}
