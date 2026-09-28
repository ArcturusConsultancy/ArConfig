/**
 * src/controllers/extractionController.js
 *
 * Orchestrates both the original subinventory snapshot and the generalized
 * Functional Setup Manager task export pipeline.
 */
const { resolveOrgCodes } = require("../orgResolver");
const path = require("path");
const { applyFusionCredentials, loadConfig, parseOrgCodes } = require("../config");
const { buildClient, verifyAuth } = require("../auth");
const { extractSubinventories } = require("../extractors/subinventories");
const { extractLocators } = require("../extractors/locators");
const { buildTaskWorkbook, buildWorkbook } = require("../excelWriter");
const { extractConfigurationItems, normalizeSelectedTasks } = require("../configurationExtractionService");
const RunHistory = require("../models/RunHistory");
const logger = require("../logger");
const { getSession } = require("../sessionStore");
const { writeAudit } = require("../auditService");
const { storeTaskPackages } = require("../oraclePackageStore");
const {
  beginTask,
  cancelProgress,
  completeProgress,
  failProgress,
  finishTask,
  getProgress,
  isProgressCancelled,
  markProgressCancelled,
  startProgress,
  updateProgress,
} = require("../extractionProgress");

function sanitizeFilenamePart(value) {
  return String(value || "Tasks")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "Tasks";
}

async function runTaskExtraction({ client, runCfg, req, res, startedAt }) {
  const session = getSession(req);
  const selectedTasks = normalizeSelectedTasks(req.body?.tasks);
  if (!selectedTasks.length) {
    return res.status(400).json({ error: "Select at least one setup task to extract." });
  }

  const functionalArea = {
    code: String(req.body?.functionalArea?.code || "").trim(),
    name: String(req.body?.functionalArea?.name || "Selected Tasks").trim(),
  };
  const offering = {
    code: String(req.body?.offering?.code || "").trim(),
    name: String(req.body?.offering?.name || "").trim(),
  };
  const progressId = startProgress(req.body?.progressId, {
    functionalAreaName: functionalArea.name,
    totalTasks: selectedTasks.length,
  });
  const taskMode = ["required", "all", "selected"].includes(req.body?.taskMode)
    ? req.body.taskMode
    : "selected";
  updateProgress(progressId, {
    phase: "extracting",
    message: `Starting ${selectedTasks.length} Oracle setup tasks...`,
  });
  const extraction = await extractConfigurationItems({
    client,
    cfg: runCfg,
    tasks: selectedTasks,
    orgCodes: runCfg.orgCodes,
    onTaskStart: (task, index) => beginTask(progressId, task, index),
    onTaskFinish: (task, index, result) => finishTask(progressId, task, index, result),
    shouldCancel: () => isProgressCancelled(progressId),
  });
  const { resolvedOrgCodes, taskResults } = extraction;

  const succeeded = taskResults.filter((task) => task.status === "success").length;
  const status = succeeded === taskResults.length ? "success" : succeeded > 0 ? "partial" : "failed";
  const recordCount = taskResults.reduce((total, task) => total + task.recordCount, 0);
  const oraclePackages = await storeTaskPackages(taskResults, progressId || Date.now());
  const filename = `ConfigSnapshot_${sanitizeFilenamePart(functionalArea.name)}_${Date.now()}.xlsx`;
  const outputPath = path.join(__dirname, "..", "..", "output", filename);

  updateProgress(progressId, {
    phase: "building",
    currentTask: null,
    message: "Building the combined Excel workbook...",
  });

  await buildTaskWorkbook({
    cfg: runCfg,
    offering,
    functionalArea,
    taskMode,
    orgCodes: resolvedOrgCodes,
    taskResults,
    outputPath,
  });

  const subinventoryCount = taskResults.reduce(
    (total, task) => total + (task.subinventoryCount || 0),
    0
  );
  const locatorCount = taskResults.reduce(
    (total, task) => total + (task.locatorCount || 0),
    0
  );
  const record = await RunHistory.create({
    ownerId: session?.ownerId || "",
    operation: "EXTRACT",
    lifecycleStatus: "COMPLETED",
    requestedBy: runCfg.username,
    configurationItems: selectedTasks.map((task) => task.code || task.name),
    parameters: { orgCodes: resolvedOrgCodes, oraclePackages },
    startedAt,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    orgCodes: resolvedOrgCodes,
    offeringCode: offering.code,
    offeringName: offering.name,
    functionalAreaCode: functionalArea.code,
    functionalAreaName: functionalArea.name,
    taskMode,
    taskCount: selectedTasks.length,
    recordCount,
    taskResults: taskResults.map((task) => ({
      code: task.code || "",
      name: task.name,
      status: task.status,
      recordCount: task.recordCount,
      errorMessage: task.errorMessage,
    })),
    subinventoryCount,
    locatorCount,
    outputFile: filename,
    status,
    errorMessage:
      status === "success"
        ? null
        : `${taskResults.length - succeeded} of ${taskResults.length} tasks failed. See Task Summary in the workbook.`,
  });

  completeProgress(
    progressId,
    status,
    `${selectedTasks.length} tasks processed. Workbook is ready.`
  );

  await writeAudit({ ownerId: session?.ownerId || "", action: "EXTRACTION_COMPLETED", metadata: { runId: record.id, taskCount: selectedTasks.length, recordCount, status, outputFile: filename } });

  return res.status(200).json({
    message:
      status === "success"
        ? "Task extraction completed"
        : "Task extraction completed with task errors",
    run: record,
    downloadUrl: `/api/reports/${encodeURIComponent(filename)}`,
  });
}

async function runExtraction(req, res) {
  const startedAt = new Date();
  const session = getSession(req);
  const cfg = session?.cfg || loadConfig();
  const requestedOrgCodes = parseOrgCodes(req.body?.orgCodes);
  const runCfg = applyFusionCredentials(
    {
      ...cfg,
      orgCodes: requestedOrgCodes.length ? requestedOrgCodes : cfg.orgCodes,
    },
    session ? {} : req.body?.fusionCredentials
  );

  if (runCfg.missing.length > 0) {
    return res.status(400).json({
      error: `Missing required Fusion credentials: ${runCfg.missing.join(", ")}. Enter them on the login page.`,
    });
  }

  const client = buildClient(runCfg);

  try {
    await writeAudit({ ownerId: session?.ownerId || "", action: "EXTRACTION_REQUESTED", metadata: { taskCount: Array.isArray(req.body?.tasks) ? req.body.tasks.length : 1 } });
    const authResult = await verifyAuth(client, runCfg);
    if (!authResult.ok) {
      await RunHistory.create({
        ownerId: session?.ownerId || "",
        operation: "EXTRACT",
        lifecycleStatus: "FAILED",
        orgCodes: runCfg.orgCodes,
        subinventoryCount: 0,
        locatorCount: 0,
        outputFile: "",
        status: "failed",
        errorMessage: authResult.message || "Authentication failed",
      });
      return res.status(authResult.status === 403 ? 403 : 401).json({
        error: authResult.message || "Authentication with Oracle Fusion failed. Check credentials.",
        status: authResult.status,
      });
    }

    if (Array.isArray(req.body?.tasks)) {
      return await runTaskExtraction({ client, runCfg, req, res, startedAt });
    }

    logger.info(`Organizations targeted: ${runCfg.orgCodes.join(", ")}`);
    const resolvedOrgCodes = await resolveOrgCodes(client, runCfg, runCfg.orgCodes);
    logger.info(`Resolved to codes: ${resolvedOrgCodes.join(", ")}`);

    const subinventoryRows = await extractSubinventories(client, runCfg, resolvedOrgCodes);
    logger.info(`Subinventories extracted: ${subinventoryRows.length}`);

    const locatorRows = await extractLocators(client, runCfg, subinventoryRows);
    logger.info(`Locators extracted: ${locatorRows.length}`);

    const filename = `ConfigSnapshot_Subinv_Locators_${Date.now()}.xlsx`;
    const outputPath = path.join(__dirname, "..", "..", "output", filename);

    await buildWorkbook({
      cfg: runCfg,
      orgCodes: resolvedOrgCodes,
      subinventoryRows,
      locatorRows,
      outputPath,
    });

    const record = await RunHistory.create({
      ownerId: session?.ownerId || "",
      operation: "EXTRACT",
      lifecycleStatus: "COMPLETED",
      requestedBy: runCfg.username,
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      orgCodes: resolvedOrgCodes,
      subinventoryCount: subinventoryRows.length,
      locatorCount: locatorRows.length,
      outputFile: filename,
      status: "success",
    });

    return res.status(200).json({
      message: "Extraction completed",
      run: record,
      downloadUrl: `/api/reports/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    if (err.code === "EXTRACTION_CANCELLED") {
      logger.info("Extraction cancelled by user");
      markProgressCancelled(req.body?.progressId, err.message);
      await RunHistory.create({
        ownerId: session?.ownerId || "",
        operation: "EXTRACT",
        lifecycleStatus: "CANCELLED",
        orgCodes: runCfg.orgCodes,
        subinventoryCount: 0,
        locatorCount: 0,
        outputFile: "",
        status: "cancelled",
        errorMessage: err.message,
      });
      await writeAudit({ ownerId: session?.ownerId || "", action: "EXTRACTION_CANCELLED", status: "CANCELLED", metadata: { message: err.message } });
      return res.status(499).json({ error: err.message, code: err.code });
    }
    logger.error(`Extraction failed: ${err.message}`);
    failProgress(req.body?.progressId, err.message);
    await RunHistory.create({
      ownerId: session?.ownerId || "",
      operation: "EXTRACT",
      lifecycleStatus: "FAILED",
      orgCodes: runCfg.orgCodes,
      subinventoryCount: 0,
      locatorCount: 0,
      outputFile: "",
      status: "failed",
      errorMessage: err.message,
    });
    await writeAudit({ ownerId: session?.ownerId || "", action: "EXTRACTION_FAILED", status: "FAILED", metadata: { message: err.message } });
    return res.status(500).json({ error: err.message });
  }
}

async function getHistory(req, res) {
  const session = getSession(req);
  const query = session ? { $or: [{ ownerId: session.ownerId }, { ownerId: "" }] } : { ownerId: "" };
  const runs = await RunHistory.find(query).sort({ createdAt: -1 }).limit(100);
  return res.status(200).json(runs);
}

async function getExtractionProgress(req, res) {
  const progress = getProgress(req.params.progressId);
  if (!progress) return res.status(404).json({ error: "Extraction progress not found." });
  return res.status(200).json(progress);
}

function cancelExtraction(req, res) {
  const progress = cancelProgress(req.params.progressId);
  if (!progress) return res.status(404).json({ error: "Extraction progress not found." });
  return res.status(200).json(progress);
}

module.exports = { runExtraction, getHistory, getExtractionProgress, cancelExtraction };
