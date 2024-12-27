import { exec } from "node:child_process";

const targets = [
  { platform: "windows-x64", output: "dist/its-cli-windows.exe" },
  { platform: "macos-x64", output: "dist/its-cli-macos" },
  { platform: "linux-x64", output: "dist/its-cli-linux" },
];

async function build() {
  for (const target of targets) {
    const command = `nexe dist/cli/index.js --targets ${target.platform} --build --output ${target.output}`;
    console.log(`Building for ${target.platform}...`);

    try {
      await new Promise((resolve, reject) => {
        const childProcess = exec(command, (error, stdout, stderr) => {
          if (error) {
            console.error(`Error building for ${target.platform}:`, error);
            reject(error);
          } else {
            console.log(
              `Successfully built for ${target.platform}:\n${stdout}`,
            );
            // @ts-ignore
            resolve();
          }
        });

        if (childProcess.stdout) {
          childProcess.stdout.on("data", (data) => {
            process.stdout.write(data);
          });
        }
        if (childProcess.stderr) {
          childProcess.stderr.on("data", (data) => {
            process.stderr.write(data);
          });
        }
      });
      // @ts-expect-error
    } catch (error: Error) {
      console.error(`Failed to build for ${target.platform}:`, error.message);
      process.exit(1);
    }
  }

  console.log("All builds completed successfully!");
}

build();
