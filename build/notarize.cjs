"use strict";

const path = require("node:path");

module.exports = async function notarizeAgentRecall(context) {
  if (process.env.AGENT_RECALL_NOTARIZE !== "true") {
    console.log("Skipping notarization (AGENT_RECALL_NOTARIZE is not true).");
    return;
  }
  if (context.electronPlatformName !== "darwin") return;

  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Signed macOS packaging requires: ${missing.join(", ")}`);
  }

  const { notarize } = require("@electron/notarize");
  await notarize({
    appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
