import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const QUALITY = 60;

export function createEvidenceRecorder(evidenceDir, { maxTurns = 50 } = {}) {
  if (!evidenceDir) return null;
  const dir = resolve(evidenceDir);
  const width = Math.max(2, String(maxTurns).length);
  return {
    captureStep: (page, turn) => capture(page, dir, stepScreenshotName(turn, width)),
    captureFinal: (page) => capture(page, dir, 'final.jpg'),
  };
}

export function stepScreenshotName(turn, width = 2) {
  return `step-${String(turn).padStart(width, '0')}.jpg`;
}

async function capture(page, dir, filename) {
  if (!page) return null;
  try {
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: resolve(dir, filename),
      type: 'jpeg',
      quality: QUALITY,
      scale: 'css',
      timeout: 5000,
    });
    return filename;
  } catch {
    return null;
  }
}
