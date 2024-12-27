import {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  Browser,
} from "@puppeteer/browsers";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BROWSER_CACHE_DIR = path.resolve(__dirname, ".browser-cache");

async function ensureBrowserInstalled(browser: Browser): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("Unsupported platform. Cannot detect browser platform.");
  }

  const buildId = await resolveBuildId(browser, platform, "latest");
  const browserPath = path.join(
    BROWSER_CACHE_DIR,
    `${platform}-${buildId}`,
    browser === Browser.CHROME ? "chrome" : "firefox",
  );

  try {
    await fs.access(browserPath);
    console.log(`Browser already installed at: ${browserPath}`);
    return browserPath;
  } catch {
    console.log(`Browser not found. Installing ${browser} (${buildId})...`);
  }

  const result = await install({
    browser,
    buildId,
    platform,
    cacheDir: BROWSER_CACHE_DIR,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      console.log(
        `Downloading ${browser}... ${(
          (downloadedBytes / totalBytes) *
          100
        ).toFixed(2)}%`,
      );
    },
  });

  console.log(`${browser} installed at: ${result.path}`);
  return result.executablePath;
}

export async function ensureChromiumInstalled(): Promise<string> {
  return await ensureBrowserInstalled(Browser.CHROME);
}
