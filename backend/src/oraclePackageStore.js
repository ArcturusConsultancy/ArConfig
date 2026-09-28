const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const PACKAGE_DIRECTORY = path.join(__dirname, "..", "output", "oracle-packages");

function safePart(value) {
  return String(value || "TASK").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "TASK";
}

async function storeTaskPackages(taskResults, runToken = Date.now()) {
  await fs.mkdir(PACKAGE_DIRECTORY, { recursive: true });
  const packages = [];
  for (const task of taskResults || []) {
    if (!Buffer.isBuffer(task.packageBuffer) || !task.packageBuffer.length || !task.code) continue;
    const filename = `${safePart(task.code)}_${safePart(runToken)}_${crypto.randomBytes(6).toString("hex")}.zip`;
    await fs.writeFile(path.join(PACKAGE_DIRECTORY, filename), task.packageBuffer, { flag: "wx", mode: 0o600 });
    packages.push({
      taskCode: task.code,
      taskName: task.name,
      filename,
      sha256: crypto.createHash("sha256").update(task.packageBuffer).digest("hex"),
    });
  }
  return packages;
}

async function readTaskPackage(packageInfo) {
  const filename = path.basename(String(packageInfo?.filename || ""));
  if (!filename || filename !== packageInfo?.filename || !/^[a-zA-Z0-9_.-]+\.zip$/.test(filename)) {
    throw new Error("The stored Oracle task package reference is invalid.");
  }
  const buffer = await fs.readFile(path.join(PACKAGE_DIRECTORY, filename));
  if (packageInfo.sha256) {
    const actual = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actual !== packageInfo.sha256) throw new Error("The stored Oracle task package failed its integrity check.");
  }
  return buffer;
}

module.exports = { readTaskPackage, storeTaskPackages };
