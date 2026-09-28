const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const JSZip = require("jszip");

const { applyFusionCredentials, loadConfig, parseOrgCodes } = require("../config");
const { buildClient, verifyAuth } = require("../auth");
const { extractConfigurationItems } = require("../configurationExtractionService");
const { buildTaskWorkbook } = require("../excelWriter");
const { listAreaTasks, listFunctionalAreas, listOfferings } = require("../setupService");
const RunHistory = require("../models/RunHistory");
const { getSession } = require("../sessionStore");
const { writeAudit } = require("../auditService");
const logger = require("../logger");
const {
  beginTask,
  completeProgress,
  failProgress,
  finishTask,
  isProgressCancelled,
  markProgressCancelled,
  startProgress,
  updateProgress,
} = require("../extractionProgress");

function safePart(value, fallback = "Item") {
  return String(value || fallback)
    .replace(/[^a-z0-9 _.-]+/gi, "")
    .replace(/\s+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 90) || fallback;
}

function throwIfCancelled(progressId) {
  if (!isProgressCancelled(progressId)) return;
  const error = new Error("Complete setup export cancelled by user.");
  error.code = "EXTRACTION_CANCELLED";
  throw error;
}

function selectableTasks(tasks) {
  const unique = new Map();
  for (const task of tasks || []) {
    if (task.available === false || !task.exportSupported) continue;
    unique.set(task.code || task.name, task);
  }
  return Array.from(unique.values());
}

async function buildPlan(client, cfg, selectedOffering, progressId) {
  const offerings = selectedOffering?.code === "ALL"
    ? await listOfferings(client, cfg)
    : [selectedOffering].filter((item) => item?.code && item?.name);

  if (!offerings.length) throw new Error("Select a setup or All Setups first.");

  const plan = [];
  for (const offering of offerings) {
    throwIfCancelled(progressId);
    updateProgress(progressId, {
      phase: "discovering",
      message: `Loading functional areas for ${offering.name}...`,
    });
    const areaResult = await listFunctionalAreas(client, cfg, offering);
    const areas = [];
    for (const area of areaResult.functionalAreas || []) {
      throwIfCancelled(progressId);
      updateProgress(progressId, {
        phase: "discovering",
        message: `Loading tasks for ${offering.name} / ${area.name}...`,
      });
      const taskResult = await listAreaTasks(client, cfg, area);
      areas.push({ area, tasks: selectableTasks(taskResult.tasks) });
    }
    plan.push({ offering, areas, note: areaResult.note || "" });
  }
  return plan;
}

async function runCompleteSetupExtraction(req, res) {
  const startedAt = new Date();
  const session = getSession(req);
  const cfg = session?.cfg || loadConfig();
  const requestedOrgCodes = parseOrgCodes(req.body?.orgCodes);
  const runCfg = applyFusionCredentials({
    ...cfg,
    orgCodes: requestedOrgCodes.length ? requestedOrgCodes : cfg.orgCodes,
  }, session ? {} : req.body?.fusionCredentials);
  const selectedOffering = {
    code: String(req.body?.offering?.code || "").trim(),
    name: String(req.body?.offering?.name || "").trim(),
  };
  const progressId = startProgress(req.body?.progressId, {
    functionalAreaName: selectedOffering.code === "ALL" ? "All Setups" : selectedOffering.name,
    totalTasks: 0,
  });
  const temporaryFiles = [];

  try {
    if (runCfg.missing.length) {
      return res.status(400).json({ error: `Missing required Fusion credentials: ${runCfg.missing.join(", ")}.` });
    }
    if (!selectedOffering.code || !selectedOffering.name) {
      return res.status(400).json({ error: "Select a setup or All Setups first." });
    }

    const client = buildClient(runCfg);
    const authResult = await verifyAuth(client, runCfg);
    if (!authResult.ok) {
      return res.status(authResult.status === 403 ? 403 : 401).json({ error: authResult.message });
    }

    updateProgress(progressId, { phase: "discovering", message: "Building the complete setup export plan..." });
    const plan = await buildPlan(client, runCfg, selectedOffering, progressId);
    const totalTasks = plan.reduce((setupTotal, setup) =>
      setupTotal + setup.areas.reduce((areaTotal, area) => areaTotal + area.tasks.length, 0), 0);
    const totalAreas = plan.reduce((total, setup) => total + setup.areas.length, 0);
    updateProgress(progressId, {
      phase: "extracting",
      totalTasks,
      message: `Extracting ${totalTasks} tasks across ${totalAreas} functional areas...`,
    });

    const zip = new JSZip();
    const allTaskResults = [];
    const allConfigurationItems = [];
    let globalTaskIndex = 0;
    let recordCount = 0;
    const manifest = [
      "ArConfig Complete Setup Export",
      `Generated: ${new Date().toISOString()}`,
      `Environment: ${runCfg.baseUrl}`,
      `Setups: ${plan.length}`,
      `Functional areas: ${totalAreas}`,
      `Tasks: ${totalTasks}`,
      "",
    ];

    for (const setup of plan) {
      const setupFolder = `${safePart(setup.offering.name)}_${safePart(setup.offering.code, "SETUP")}`;
      manifest.push(`Setup: ${setup.offering.name} (${setup.offering.code})`);
      if (setup.note) manifest.push(`  Area discovery: ${setup.note}`);
      for (const { area, tasks } of setup.areas) {
        throwIfCancelled(progressId);
        const areaStartIndex = globalTaskIndex;
        updateProgress(progressId, {
          functionalAreaName: `${setup.offering.name} / ${area.name}`,
          message: tasks.length
            ? `Extracting ${setup.offering.name} / ${area.name}...`
            : `Creating empty workbook for ${setup.offering.name} / ${area.name}...`,
        });
        const extraction = await extractConfigurationItems({
          client,
          cfg: runCfg,
          tasks,
          orgCodes: runCfg.orgCodes,
          onTaskStart: (task, index) => beginTask(progressId, task, areaStartIndex + index),
          onTaskFinish: (task, index, result) => finishTask(progressId, task, areaStartIndex + index, result),
          shouldCancel: () => isProgressCancelled(progressId),
        });
        globalTaskIndex += tasks.length;
        const areaResults = extraction.taskResults;
        allTaskResults.push(...areaResults.map((task) => ({
          code: task.code,
          name: task.name,
          status: task.status,
          recordCount: task.recordCount || 0,
          errorMessage: task.errorMessage || "",
        })));
        allConfigurationItems.push(...tasks.map((task) => task.code || task.name));
        recordCount += areaResults.reduce((total, task) => total + (task.recordCount || 0), 0);

        const workbookName = `${safePart(area.name)}_${safePart(area.code, "AREA")}.xlsx`;
        const temporaryPath = path.join(__dirname, "..", "..", "output", `.building_${Date.now()}_${safePart(setup.offering.code)}_${workbookName}`);
        temporaryFiles.push(temporaryPath);
        await buildTaskWorkbook({
          cfg: runCfg,
          offering: setup.offering,
          functionalArea: area,
          taskMode: "all",
          orgCodes: extraction.resolvedOrgCodes,
          taskResults: areaResults,
          outputPath: temporaryPath,
        });
        zip.file(`${setupFolder}/${workbookName}`, fs.createReadStream(temporaryPath));
        manifest.push(`  ${area.name}: ${tasks.length} tasks, ${areaResults.reduce((sum, task) => sum + (task.recordCount || 0), 0)} records`);
      }
      manifest.push("");
    }

    zip.file("Export_Manifest.txt", manifest.join("\n"));
    throwIfCancelled(progressId);
    updateProgress(progressId, { phase: "building", currentTask: null, message: "Packaging setup workbooks into a ZIP file..." });
    const filename = `ArConfig_${selectedOffering.code === "ALL" ? "All_Setups" : safePart(selectedOffering.name)}_${Date.now()}.zip`;
    const outputPath = path.join(__dirname, "..", "..", "output", filename);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await pipeline(
      zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } }),
      fs.createWriteStream(outputPath)
    );

    const succeeded = allTaskResults.filter((task) => task.status === "success").length;
    const status = succeeded === allTaskResults.length ? "success" : succeeded ? "partial" : "failed";
    const record = await RunHistory.create({
      ownerId: session?.ownerId || "",
      operation: "EXTRACT",
      lifecycleStatus: status === "success" ? "COMPLETED" : status === "partial" ? "PARTIALLY_COMPLETED" : "FAILED",
      requestedBy: runCfg.username,
      configurationItems: allConfigurationItems,
      parameters: { orgCodes: runCfg.orgCodes, completeSetup: true, setupCount: plan.length, functionalAreaCount: totalAreas },
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      orgCodes: runCfg.orgCodes,
      offeringCode: selectedOffering.code,
      offeringName: selectedOffering.name,
      functionalAreaCode: "ALL",
      functionalAreaName: "All Functional Areas",
      taskMode: "all",
      taskCount: totalTasks,
      recordCount,
      taskResults: allTaskResults.map((task) => ({
        code: task.code || "",
        name: task.name,
        status: task.status,
        recordCount: task.recordCount || 0,
        errorMessage: task.errorMessage || "",
      })),
      outputFile: filename,
      status,
      errorMessage: status === "success" ? null : `${allTaskResults.length - succeeded} tasks failed. Review the task summaries inside the ZIP workbooks.`,
    });

    completeProgress(progressId, status, `${plan.length} setups and ${totalAreas} functional areas packaged. ZIP is ready.`);
    await writeAudit({ ownerId: session?.ownerId || "", action: "COMPLETE_SETUP_EXTRACTION_COMPLETED", metadata: { runId: record.id, setupCount: plan.length, functionalAreaCount: totalAreas, taskCount: totalTasks, recordCount, outputFile: filename } });
    return res.status(200).json({
      message: "Complete setup extraction finished",
      run: record,
      downloadUrl: `/api/reports/${encodeURIComponent(filename)}`,
    });
  } catch (error) {
    if (error.code === "EXTRACTION_CANCELLED") {
      markProgressCancelled(progressId, error.message);
      await writeAudit({ ownerId: session?.ownerId || "", action: "COMPLETE_SETUP_EXTRACTION_CANCELLED", status: "CANCELLED", metadata: { message: error.message } });
      return res.status(409).json({ error: error.message, code: error.code });
    }
    logger.error(`Complete setup extraction failed: ${error.message}`);
    failProgress(progressId, error.message);
    await writeAudit({ ownerId: session?.ownerId || "", action: "COMPLETE_SETUP_EXTRACTION_FAILED", status: "FAILED", metadata: { message: error.message } });
    return res.status(500).json({ error: error.message });
  } finally {
    await Promise.all(temporaryFiles.map((file) => fs.promises.unlink(file).catch(() => {})));
  }
}

module.exports = { runCompleteSetupExtraction };
