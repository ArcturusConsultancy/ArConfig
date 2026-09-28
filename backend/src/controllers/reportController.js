const path = require("path");
const RunHistory = require("../models/RunHistory");
const { writeAudit } = require("../auditService");
const { getSession } = require("../sessionStore");

async function download(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Sign in again to download reports.", code: "AUTHENTICATION_FAILED" });
  const filename = String(req.params.filename || "");
  if (!filename || filename !== path.basename(filename) || !/^[a-zA-Z0-9_.-]+\.(xlsx|zip)$/.test(filename)) {
    return res.status(400).json({ error: "Invalid report filename.", code: "REPORT_GENERATION_FAILED" });
  }
  const run = await RunHistory.findOne({ $or: [{ ownerId: session.ownerId }, { ownerId: "" }], outputFile: filename });
  if (!run) return res.status(404).json({ error: "Report was not found for this user.", code: "UNAUTHORIZED_CONNECTION" });
  const filePath = path.join(__dirname, "..", "..", "output", filename);
  await writeAudit({ ownerId: session.ownerId, action: "REPORT_DOWNLOADED", metadata: { runId: run.id, operation: run.operation, outputFile: filename } });
  return res.download(filePath, filename, (error) => {
    if (error && !res.headersSent) res.status(error.code === "ENOENT" ? 404 : 500).json({ error: "Report file is unavailable.", code: "REPORT_GENERATION_FAILED" });
  });
}

module.exports = { download };
