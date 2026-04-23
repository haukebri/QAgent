import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export interface BrowserSession {
  sessionName: string;
  socketDir: string;
}

function agentBrowser(args: string[], sessionName: string, socketDir: string, globalFlags: string[] = []): string {
  try {
    return execFileSync("agent-browser", [...globalFlags, "--session", sessionName, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_BROWSER_SOCKET_DIR: socketDir,
      },
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
}): BrowserSession {
  const sessionName = `qa-${crypto.randomBytes(4).toString("hex")}`;
  const socketDir = path.resolve(opts.socketDir);
  const globalFlags = opts.headed ? ["--headed"] : [];
  mkdirSync(socketDir, { recursive: true });

  // Set HTTP basic auth credentials before navigating
  if (opts.basicAuth) {
    agentBrowser(["set", "credentials", opts.basicAuth.username, opts.basicAuth.password], sessionName, socketDir, globalFlags);
  }

  // Open the URL — this verifies the site is reachable and starts the browser
  agentBrowser(["open", opts.url], sessionName, socketDir, globalFlags);

  return { sessionName, socketDir };
}

export function closeBrowserSession(session: BrowserSession): void {
  try {
    execFileSync("agent-browser", ["--session", session.sessionName, "close"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_BROWSER_SOCKET_DIR: session.socketDir,
      },
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
