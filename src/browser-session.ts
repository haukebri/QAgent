import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

export interface BrowserSession {
  sessionName: string;
}

function agentBrowser(args: string[], sessionName: string, globalFlags: string[] = []): string {
  try {
    return execFileSync("agent-browser", [...globalFlags, "--session", sessionName, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
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
}): BrowserSession {
  const sessionName = `qagent-${crypto.randomBytes(4).toString("hex")}`;
  const globalFlags = opts.headed ? ["--headed"] : [];

  // Set HTTP basic auth credentials before navigating
  if (opts.basicAuth) {
    agentBrowser(["set", "credentials", opts.basicAuth.username, opts.basicAuth.password], sessionName, globalFlags);
  }

  // Open the URL — this verifies the site is reachable and starts the browser
  agentBrowser(["open", opts.url], sessionName, globalFlags);

  return { sessionName };
}

export function closeBrowserSession(session: BrowserSession): void {
  try {
    execFileSync("agent-browser", ["--session", session.sessionName, "close"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort cleanup; don't fail the run
  }
}
