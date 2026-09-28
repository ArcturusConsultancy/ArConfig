const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const { buildClient, verifyAuth } = require("../auth");
const { writeAudit } = require("../auditService");
const { compareConfigurations } = require("../comparisonEngine");
const { buildComparisonWorkbook } = require("../comparisonReport");
const { extractConfigurationItems } = require("../configurationExtractionService");
const { loadConfig, parseOrgCodes } = require("../config");
const { getConnectionConfig } = require("../environmentService");
const { AppError, errorResponse } = require("../errors");
const { normalizeExtraction } = require("../normalizationService");
const RunHistory = require("../models/RunHistory");
const { getSession } = require("../sessionStore");
const { listAreaTasks, listFunctionalAreas, listOfferings } = require("../setupService");

function safePart(value, fallback = "Item") {
  return String(value || fallback)
    .replace(/[^a-z0-9 _.-]+/gi, "")
    .replace(/\s+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 80) || fallback;
}

function selectableTasks(tasks) {
  const unique = new Map();
  for (const task of tasks || []) {
    if (task.available === false || !task.exportSupported) continue;
    unique.set(task.code || task.name, task);
  }
  return Array.from(unique.values());
}

async function authenticatedConnection(ownerId, id, baseCfg) {
  const stored = await getConnectionConfig(ownerId, id);
  const cfg = { ...baseCfg, ...stored.cfg, missing: [] };
  const client = buildClient(cfg);
  const auth = await verifyAuth(client, cfg);
  if (!auth.ok) throw new AppError("AUTHENTICATION_FAILED", auth.message || `Authentication failed for ${stored.connection.name}.`, undefined, auth.status);
  return { connection: stored.connection, cfg, client };
}

async function buildPlan(client, cfg, selectedOffering) {
  const offerings = selectedOffering.code === "ALL"
    ? await listOfferings(client, cfg)
    : [selectedOffering];
  const plan = [];
  for (const offering of offerings) {
    const areaResult = await listFunctionalAreas(client, cfg, offering);
    const areas = [];
    for (const area of areaResult.functionalAreas || []) {
      const taskResult = await listAreaTasks(client, cfg, area);
      areas.push({ area, tasks: selectableTasks(taskResult.tasks) });
    }
    plan.push({ offering, areas });
  }
  return plan;
}

function addSummary(target, source) {
  for (const key of ["totalSourceRecords", "totalTargetRecords", "matched", "modified", "added", "removed", "unchanged", "warnings"]) {
    target[key] += Number(source[key] || 0);
  }
}

async function compareComplete(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Sign in again before comparing environments.", code: "AUTHENTICATION_FAILED" });
  const startedAt = new Date();
  const temporaryFiles = [];
  let history;
  try {
    const selectedOffering = {
      code: String(req.body?.offering?.code || "").trim(),
      name: String(req.body?.offering?.name || "").trim(),
    };
    if (!selectedOffering.code || !selectedOffering.name) throw new AppError("MISSING_PARAMETER", "Select one setup or All Setups.");
    if (!req.body?.sourceConnectionId || !req.body?.targetConnectionId) throw new AppError("MISSING_PARAMETER", "Select both source and target environments.");
    if (req.body.sourceConnectionId === req.body.targetConnectionId) throw new AppError("INVALID_CONNECTION", "Source and target environments must be different.");

    const baseCfg = loadConfig();
    const orgCodes = parseOrgCodes(req.body?.orgCodes);
    const [source, target] = await Promise.all([
      authenticatedConnection(session.ownerId, req.body.sourceConnectionId, baseCfg),
      authenticatedConnection(session.ownerId, req.body.targetConnectionId, baseCfg),
    ]);
    history = await RunHistory.create({
      ownerId: session.ownerId,
      operation: "COMPARE",
      lifecycleStatus: "RUNNING",
      requestedBy: session.cfg.username,
      sourceConnection: { id: source.connection.id, name: source.connection.name, environmentType: source.connection.environmentType },
      targetConnection: { id: target.connection.id, name: target.connection.name, environmentType: target.connection.environmentType },
      offeringCode: selectedOffering.code,
      offeringName: selectedOffering.name,
      functionalAreaCode: "ALL",
      functionalAreaName: "All Functional Areas",
      parameters: { orgCodes, completeSetup: true },
      taskMode: "all",
      status: "success",
      startedAt,
    });

    const plan = await buildPlan(source.client, source.cfg, selectedOffering);
    const zip = new JSZip();
    const summary = { totalSourceRecords: 0, totalTargetRecords: 0, matched: 0, modified: 0, added: 0, removed: 0, unchanged: 0, warnings: 0 };
    const results = [];
    const warnings = [];
    const taskResults = [];
    const configurationItems = [];
    let taskCount = 0;
    let areaCount = 0;
    const manifest = [
      "ArConfig Complete Comparison",
      `Generated: ${new Date().toISOString()}`,
      `Source: ${source.connection.name}`,
      `Target: ${target.connection.name}`,
      "",
    ];

    for (const setup of plan) {
      const setupFolder = `${safePart(setup.offering.name)}_${safePart(setup.offering.code, "SETUP")}`;
      manifest.push(`Setup: ${setup.offering.name} (${setup.offering.code})`);
      for (const { area, tasks } of setup.areas) {
        areaCount += 1;
        taskCount += tasks.length;
        configurationItems.push(...tasks.map((task) => task.code || task.name));
        const [sourceExtraction, targetExtraction] = await Promise.all([
          extractConfigurationItems({ client: source.client, cfg: source.cfg, tasks, orgCodes: orgCodes.length ? orgCodes : source.cfg.orgCodes }),
          extractConfigurationItems({ client: target.client, cfg: target.cfg, tasks, orgCodes: orgCodes.length ? orgCodes : target.cfg.orgCodes }),
        ]);
        const context = { offering: setup.offering, functionalArea: area, module: area.name };
        const sourceNormalized = normalizeExtraction(sourceExtraction.taskResults, { ...context, environmentName: source.connection.name });
        const targetNormalized = normalizeExtraction(targetExtraction.taskResults, { ...context, environmentName: target.connection.name });
        const comparison = compareConfigurations(sourceNormalized.items, targetNormalized.items);
        comparison.warnings.push(
          ...sourceNormalized.warnings.map((warning) => ({ ...warning, side: "SOURCE", setup: setup.offering.name, functionalArea: area.name })),
          ...targetNormalized.warnings.map((warning) => ({ ...warning, side: "TARGET", setup: setup.offering.name, functionalArea: area.name }))
        );
        comparison.summary.warnings = comparison.warnings.length;
        addSummary(summary, comparison.summary);
        results.push(...comparison.results.map((result) => ({ ...result, setupName: setup.offering.name, functionalAreaName: area.name })));
        warnings.push(...comparison.warnings);
        taskResults.push(...sourceExtraction.taskResults, ...targetExtraction.taskResults);

        const workbookName = `${safePart(area.name)}_${safePart(area.code, "AREA")}_Comparison.xlsx`;
        const temporaryPath = path.join(__dirname, "..", "..", "output", `.building_compare_${Date.now()}_${safePart(setup.offering.code)}_${workbookName}`);
        temporaryFiles.push(temporaryPath);
        await buildComparisonWorkbook({ comparison, source: source.connection, target: target.connection, context, outputPath: temporaryPath });
        zip.file(`${setupFolder}/${workbookName}`, await fs.promises.readFile(temporaryPath));
        await fs.promises.unlink(temporaryPath).catch(() => {});
        manifest.push(`  ${area.name}: ${tasks.length} tasks, ${comparison.results.length} comparison records`);
      }
      manifest.push("");
    }

    if (!taskCount) throw new AppError("CONFIG_ITEM_NOT_SUPPORTED", "No exportable configuration tasks were found for the selected comparison scope.");
    zip.file("Comparison_Manifest.txt", manifest.join("\n"));
    const filename = `ConfigComparison_${selectedOffering.code === "ALL" ? "All_Setups" : safePart(selectedOffering.name)}_${safePart(source.connection.name)}_vs_${safePart(target.connection.name)}_${Date.now()}.zip`;
    const outputPath = path.join(__dirname, "..", "..", "output", filename);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));

    const failedTasks = taskResults.filter((task) => task.status === "failed");
    const successfulTasks = taskResults.filter((task) => task.status === "success");
    const runStatus = failedTasks.length === 0 ? "success" : successfulTasks.length ? "partial" : "failed";
    const completedAt = new Date();
    history.lifecycleStatus = runStatus === "success" ? "COMPLETED" : runStatus === "partial" ? "PARTIALLY_COMPLETED" : "FAILED";
    history.status = runStatus;
    history.configurationItems = Array.from(new Set(configurationItems));
    history.parameters = { orgCodes, completeSetup: true, setupCount: plan.length, functionalAreaCount: areaCount };
    history.taskCount = taskCount;
    history.recordCount = summary.totalSourceRecords + summary.totalTargetRecords;
    history.resultSummary = summary;
    history.warnings = warnings.slice(0, 100);
    history.outputFile = filename;
    history.completedAt = completedAt;
    history.durationMs = completedAt - startedAt;
    history.errorMessage = failedTasks.length ? `${failedTasks.length} source/target task extractions failed.` : null;
    await history.save();
    await writeAudit({ ownerId: session.ownerId, action: "COMPLETE_COMPARISON_COMPLETED", metadata: { runId: history.id, setupCount: plan.length, functionalAreaCount: areaCount, taskCount, summary, outputFile: filename } });
    return res.json({
      run: history,
      summary,
      warnings,
      results: results.slice(0, 5000),
      truncated: results.length > 5000,
      completeScope: true,
      downloadUrl: `/api/reports/${encodeURIComponent(filename)}`,
    });
  } catch (error) {
    if (history) {
      history.lifecycleStatus = "FAILED";
      history.status = "failed";
      history.errorMessage = error.message;
      history.completedAt = new Date();
      history.durationMs = history.completedAt - startedAt;
      await history.save().catch(() => {});
    }
    await writeAudit({ ownerId: session.ownerId, action: "COMPLETE_COMPARISON_FAILED", status: "FAILED", metadata: { runId: history?.id, errorCode: error.code || "COMPARISON_FAILED", message: error.message } });
    const response = errorResponse(error);
    return res.status(response.status).json(response.body);
  } finally {
    await Promise.all(temporaryFiles.map((file) => fs.promises.unlink(file).catch(() => {})));
  }
}

module.exports = { compareComplete };
