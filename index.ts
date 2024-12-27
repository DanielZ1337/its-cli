import puppeteer from "puppeteer";
import { ItsLearningSDK } from "itslearning-sdk";
import { ItslearningRestApiEntitiesPersonContextRole } from "itslearning-sdk/types";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs/promises";

// Choose the key format you are using
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY_HEX;
const ENCRYPTION_KEY_BASE64 = process.env.ENCRYPTION_KEY_BASE64;

let ENCRYPTION_KEY: Buffer;

// Validate and set the encryption key
if (ENCRYPTION_KEY_HEX) {
  const keyBuffer = Buffer.from(ENCRYPTION_KEY_HEX, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY_HEX must be 32 bytes (64 hex characters) long.",
    );
  }
  ENCRYPTION_KEY = keyBuffer;
} else if (ENCRYPTION_KEY_BASE64) {
  const keyBuffer = Buffer.from(ENCRYPTION_KEY_BASE64, "base64");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY_BASE64 must be 32 bytes (44 Base64 characters) long.",
    );
  }
  ENCRYPTION_KEY = keyBuffer;
} else {
  throw new Error(
    "ENCRYPTION_KEY_HEX or ENCRYPTION_KEY_BASE64 environment variable must be set.",
  );
}
const IV_LENGTH = 16;

function encrypt(text: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

// Decrypt text using AES-256-CBC
function decrypt(text: string) {
  const parts = text.split(":");
  const shifted = parts.shift();
  if (!shifted) return;
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
    if (!decryptedData) throw new Error("couldn't decrypt");
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

// Load existing tokens if available
await loadTokens(itslearning.config);

try {
  await itslearning.auth.handleRefreshToken();
} catch (err) {
  await loginRetrieveAccessPuppeteer(itslearning);
}

await saveTokens(itslearning.config);

const preferredOrg = await itslearning.sites.getSiteByShortname("sdu");
itslearning.config.setBaseURL(preferredOrg.BaseUrl);

async function loginRetrieveAccessPuppeteer(itslearning: ItsLearningSDK) {
  let hasValidToken = false;
  const options = {
    width: 800,
    height: 600,
  };

  const browser = await puppeteer.launch({
    headless: false,
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
