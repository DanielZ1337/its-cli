import puppeteer from "puppeteer";
import { ItsLearningSDK } from "itslearning-sdk";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs/promises";
import keytar from "keytar";
import inquirer from "inquirer";

const SERVICE_NAME = "its-cli";
const ACCOUNT_NAME = "user";

async function getEncryptionKey(): Promise<Buffer> {
  let key: string | null | undefined =
    process.env.ENCRYPTION_KEY_HEX || process.env.ENCRYPTION_KEY_BASE64;

  if (!key) {
    key = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  }

  if (!key) {
    const answers = await inquirer.prompt([
      {
        type: "password",
        name: "encryptionKey",
        message: "Enter your encryption key:",
        mask: "*",
      },
    ]);

    key = answers.encryptionKey;

    // Optionally, save the key securely
    const saveKey = await inquirer.prompt([
      {
        type: "confirm",
        name: "save",
        message: "Would you like to save this key for future use?",
        default: false,
      },
    ]);

    if (saveKey.save && key) {
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, key);
    }
  }

  if (!key) throw new Error("your mom");

  // Validate and convert the key
  let ENCRYPTION_KEY: Buffer;

  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    ENCRYPTION_KEY = Buffer.from(key, "hex");
  } else if (key.length === 44 && /^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    ENCRYPTION_KEY = Buffer.from(key, "base64");
  } else {
    throw new Error("Invalid encryption key format.");
  }

  if (ENCRYPTION_KEY.length !== 32) {
    throw new Error("Encryption key must be 32 bytes long.");
  }

  return ENCRYPTION_KEY;
}

const ENCRYPTION_KEY = await getEncryptionKey();

const IV_LENGTH = 16;

// Encrypt text using AES-256-CBC
function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

// Decrypt text using AES-256-CBC
function decrypt(text: string): string | undefined {
  const parts = text.split(":");
  const shifted = parts.shift();
  if (!shifted) return undefined;
  const iv = Buffer.from(shifted, "hex");
  const encryptedText = parts.join(":");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// Determine file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tokenFilePath = path.join(__dirname, "tokens.enc");
const userDataPath = path.join(__dirname, "puppeteer_data");

// Function to load tokens from encrypted file
async function loadTokens(config: typeof itslearning.config) {
  try {
    const encryptedData = await fs.readFile(tokenFilePath, "utf8");
    const decryptedData = decrypt(encryptedData);
    if (!decryptedData) throw new Error("Couldn't decrypt tokens.");
    const tokens = JSON.parse(decryptedData);
    if (tokens.accessToken) config.setAccessToken(tokens.accessToken);
    if (tokens.refreshToken) config.setRefreshToken(tokens.refreshToken);
  } catch {
    // If file doesn't exist or decryption fails, proceed without tokens
  }
}

// Function to save tokens to encrypted file
async function saveTokens(config: typeof itslearning.config) {
  const tokens = {
    accessToken: config.getAccessToken(),
    refreshToken: config.getRefreshToken(),
  };
  const data = JSON.stringify(tokens);
  const encryptedData = encrypt(data);
  await fs.writeFile(tokenFilePath, encryptedData, "utf8");
}

const itslearning = new ItsLearningSDK();

const preferredOrg = await itslearning.sites.getSiteByShortname("sdu");
itslearning.config.setBaseURL(preferredOrg.BaseUrl);

// Load existing tokens if available
await loadTokens(itslearning.config);

try {
  await itslearning.auth.handleRefreshToken();
} catch (err) {
  await loginRetrieveAccessPuppeteer(itslearning);
}

await saveTokens(itslearning.config);

async function loginRetrieveAccessPuppeteer(itslearning: ItsLearningSDK) {
  let hasValidToken = false;
  const options = {
    width: 800,
    height: 600,
  };

  // Determine __dirname in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Function to get Chromium path
  async function getChromiumExecutablePath(): Promise<string> {
    const chromiumPath = puppeteer.executablePath();
    if (!chromiumPath) {
      throw new Error("Could not determine the Chromium executable path.");
    }
    return chromiumPath;
  }

  const chromiumPath = await getChromiumExecutablePath();

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromiumPath,
    defaultViewport: {
      height: options.height,
      width: options.width,
    },
    args: [
      `--window-size=${options.width},${options.height}`,
      `--app=${itslearning.auth.getAuthorizationUrl("test", "SCOPE")}`,
    ],
    userDataDir: userDataPath,
  });

  const [page] = await browser.pages();

  const loginButton = await page.waitForSelector(
    "#ctl00_ContentPlaceHolder1_federatedLoginWrapper > a",
  );
  await loginButton?.click();

  page.on("request", async (interceptedRequest) => {
    const url = new URL(interceptedRequest.url());
    const code = url.searchParams.get("code");
    if (!code) return;

    await page.close();
    await browser.close();

    await itslearning.auth.exchangeCodeForToken(code);

    await saveTokens(itslearning.config);

    hasValidToken = true;
  });

  while (!hasValidToken) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (!itslearning.auth.getAccessToken())
  await loginRetrieveAccessPuppeteer(itslearning);

try {
  await itslearning.person.getMyProfile();
} catch (err) {
  await loginRetrieveAccessPuppeteer(itslearning);
}

console.log(await itslearning.courses.getCoursesV3());
