import puppeteer from "puppeteer";
import { ItsLearningSDK } from "itslearning-sdk";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs/promises";
import keytar from "keytar";
import inquirer from "inquirer";
import os from "os";
import { ensureChromiumInstalled } from "./installBrowser";
import { Command } from "commander";
import package_json from "../package.json" assert { type: "json" };

(async function main() {
  const SERVICE_NAME = "its-cli";
  const ACCOUNT_NAME = "user";
  const program = new Command();

  async function getEncryptionKey() {
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

    if (!key) throw new Error("Encryption key is required.");

    let ENCRYPTION_KEY;

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

  function encrypt(text: string) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  function decrypt(text: string) {
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

  const tokenFilePath = path.join(__dirname, "tokens.enc");
  const userDataPath = path.join(__dirname, "puppeteer_data");

  async function loadTokens(config: typeof itslearning.config) {
    try {
      const encryptedData = await fs.readFile(tokenFilePath, "utf8");
      const decryptedData = decrypt(encryptedData);
      if (!decryptedData) throw new Error("Couldn't decrypt tokens.");
      const tokens = JSON.parse(decryptedData);
      console.log(tokens);
      if (tokens.accessToken) config.setAccessToken(tokens.accessToken);
      if (tokens.refreshToken) config.setRefreshToken(tokens.refreshToken);
    } catch (error) {
      console.error(error);
      // If file doesn't exist or decryption fails, proceed without tokens
    }
  }

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

  async function loginRetrieveAccessPuppeteer() {
    let hasValidToken = false;
    const options = {
      width: 800,
      height: 600,
    };

    const chromiumPath = await ensureChromiumInstalled();

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

  program
    .name("its-cli")
    .description("CLI tool for itslearning")
    .version(package_json.version);

  program
    .command("login")
    .description("Login to itslearning")
    .action(async () => {
      console.log("Starting login process...");

      try {
        const preferredOrg = await itslearning.sites.getSiteByShortname("sdu");
        itslearning.config.setBaseURL(preferredOrg.BaseUrl);

        await loadTokens(itslearning.config);

        try {
          await itslearning.auth.handleRefreshToken();
        } catch {
          await loginRetrieveAccessPuppeteer();
        }

        await saveTokens(itslearning.config);
        console.log("Login successful!");
      } catch (error) {
        console.error("Login failed:", error.message);
      }
    });

  program
    .command("courses")
    .description("List available courses")
    .action(async () => {
      try {
        await loadTokens(itslearning.config);
        const courses = await itslearning.courses.getCoursesV3();
        console.log("Available courses:", courses);
      } catch (error) {
        console.error("Failed to fetch courses:", error.message);
      }
    });

  // **Logout Command Addition**
  program
    .command("logout")
    .description("Logout from itslearning and remove stored tokens")
    .action(async () => {
      const confirmation = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmLogout",
          message:
            "Are you sure you want to logout? This will remove all stored credentials.",
          default: false,
        },
      ]);

      if (!confirmation.confirmLogout) {
        console.log("Logout cancelled.");
        return;
      }

      try {
        // Delete the encrypted tokens file
        try {
          await fs.unlink(tokenFilePath);
          console.log("Deleted tokens file.");
        } catch (err) {
          if (err.code === "ENOENT") {
            console.log("No tokens file found to delete.");
          } else {
            throw err;
          }
        }

        // Delete Puppeteer's user data directory
        try {
          await fs.rm(userDataPath, { recursive: true, force: true });
          console.log("Deleted Puppeteer user data directory.");
        } catch (err) {
          console.error(
            "Failed to delete Puppeteer user data directory:",
            err.message,
          );
        }

        // Check if encryption key is stored in keytar
        const storedKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
        if (storedKey) {
          const deleteKeyConfirmation = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmDeleteKey",
              message: "Do you also want to delete the saved encryption key?",
              default: false,
            },
          ]);

          if (deleteKeyConfirmation.confirmDeleteKey) {
            const keyDeleted = await keytar.deletePassword(
              SERVICE_NAME,
              ACCOUNT_NAME,
            );
            if (keyDeleted) {
              console.log("Encryption key deleted from keychain.");
            } else {
              console.log("Failed to delete encryption key from keychain.");
            }
          } else {
            console.log("Encryption key retained.");
          }
        } else {
          console.log("No encryption key found in keychain.");
        }

        console.log("Logout successful!");
      } catch (error) {
        console.error("An error occurred during logout:", error.message);
      }
    });

  program.parse(process.argv);
})();
