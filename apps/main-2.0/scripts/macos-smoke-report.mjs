import fs from "node:fs/promises";

export async function runMacosVerification(reportPath, verify) {
  await fs.rm(reportPath, { force: true });
  const report = await verify();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}
