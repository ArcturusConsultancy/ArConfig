const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { buildClient, verifyAuth } = require("./auth");
const { writeAudit } = require("./auditService");
const { compareConfigurations } = require("./comparisonEngine");
const { extractConfigurationItems, normalizeSelectedTasks } = require("./configurationExtractionService");
const { loadConfig, parseOrgCodes } = require("./config");
const { getConnectionConfig } = require("./environmentService");
const { AppError } = require("./errors");
const { normalizeExtraction } = require("./normalizationService");
const { getConfigurationItem } = require("./configurationRegistry");
const { buildMigrationWorkbook } = require("./migrationReport");
const { validateMigration } = require("./oracleMigrationAdapter");
const { readTaskPackage } = require("./oraclePackageStore");
const { checkTaskImportSupported, importTaskPackage } = require("./setupTaskImportService");
const { collectCsvFiles } = require("./taskExportService");
const { parseWorkbookBuffer } = require("./workbookImportService");
const MigrationPlan = require("./models/MigrationPlan");
const RunHistory = require("./models/RunHistory");
const { startMigrationProgress, updateMigrationProgress } = require("./migrationProgress");

function safeFilename(value) {
  return String(value || "Migration").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "Migration";
}

function stableJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item).sort().reduce((acc, currentKey) => {
      acc[currentKey] = item[currentKey];
      return acc;
    }, {});
  });
}

function makeHash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

async function authenticatedConnection(ownerId, id, baseCfg) {
  const stored = await getConnectionConfig(ownerId, id);
  const cfg = { ...baseCfg, ...stored.cfg, missing: [] };
  const client = buildClient(cfg);
  const auth = await verifyAuth(client, cfg);
  if (!auth.ok) throw new AppError("DESTINATION_CONNECTION_FAILED", auth.message || `Authentication failed for ${stored.connection.name}.`, undefined, auth.status);
  return { connection: stored.connection, cfg, client };
}

async function listMigrationSources(ownerId) {
  const runs = await RunHistory.find({
    $or: [{ ownerId }, { ownerId: "" }],
    operation: "EXTRACT",
    outputFile: { $regex: /\.xlsx$/i },
    status: { $in: ["success", "partial"] },
  }).sort({ createdAt: -1 }).limit(100);
  return runs.map((run) => ({
    id: run.id,
    label: `${run.offeringName || "Snapshot"} · ${run.functionalAreaName || "Selected Tasks"} · ${new Date(run.createdAt).toLocaleString()}`,
    outputFile: run.outputFile,
    offering: { code: run.offeringCode, name: run.offeringName },
    functionalArea: { code: run.functionalAreaCode, name: run.functionalAreaName },
    taskCount: run.taskCount,
    recordCount: run.recordCount,
    createdAt: run.createdAt,
    automatedImportReady: Array.isArray(run.parameters?.oraclePackages) && run.parameters.oraclePackages.length > 0,
  }));
}

function outputPathFor(filename) {
  const base = path.join(__dirname, "..", "output");
  const cleaned = path.basename(String(filename || ""));
  return path.join(base, cleaned);
}

async function loadExistingExtraction(ownerId, sourceRunId, context) {
  const run = await RunHistory.findOne({
    _id: sourceRunId,
    $or: [{ ownerId }, { ownerId: "" }],
    operation: "EXTRACT",
    outputFile: { $ne: "" },
  });
  if (!run) throw new AppError("INVALID_MIGRATION_SOURCE", "Select a valid extraction run owned by this user.");
  const filePath = outputPathFor(run.outputFile);
  const buffer = await fs.readFile(filePath).catch(() => null);
  if (!buffer) throw new AppError("INVALID_MIGRATION_SOURCE", "The selected extraction workbook is no longer available on disk.");
  const imported = await parseWorkbookBuffer(buffer, {
    filename: run.outputFile,
    functionalArea: context.functionalArea || { name: run.functionalAreaName },
    module: context.module || run.functionalAreaName,
    environmentName: run.sourceConnection?.name || "Existing Extraction",
  });
  const oraclePackages = Array.isArray(run.parameters?.oraclePackages) ? run.parameters.oraclePackages : [];
  let normalized = imported.normalized;
  let sourceHash = imported.sourceHash;

  // Automation-ready snapshots retain Oracle's original task ZIP. Normalize
  // those source CSV files directly so the comparison uses the same raw shape
  // as the live destination extraction. The generated Excel workbook contains
  // presentation headings and summaries that must never become migration rows.
  if (oraclePackages.length) {
    const packagedTaskResults = [];
    for (const packageInfo of oraclePackages) {
      const packageBuffer = await readTaskPackage(packageInfo);
      const files = await collectCsvFiles(packageBuffer);
      const taskResult = (run.taskResults || []).find((task) =>
        String(task.code || "").toUpperCase() === String(packageInfo.taskCode || "").toUpperCase()
      );
      packagedTaskResults.push({
        code: packageInfo.taskCode,
        name: packageInfo.taskName || taskResult?.name || packageInfo.taskCode,
        status: "success",
        files,
      });
    }
    normalized = normalizeExtraction(packagedTaskResults, {
      functionalArea: context.functionalArea || { name: run.functionalAreaName },
      module: context.module || run.functionalAreaName,
      environmentName: run.sourceConnection?.name || "Existing Extraction",
    });
    sourceHash = makeHash(oraclePackages.map((item) => ({ taskCode: item.taskCode, sha256: item.sha256 })));
  }
  return {
    type: "EXTRACTION",
    id: run.id,
    label: run.outputFile,
    sourceHash,
    normalized,
    metadata: imported.metadata,
    oraclePackages,
  };
}

async function loadUploadedWorkbook(buffer, options, context) {
  const imported = await parseWorkbookBuffer(buffer, {
    filename: options.filename,
    functionalArea: context.functionalArea,
    module: context.module,
    environmentName: "Uploaded Workbook",
  });
  return {
    type: "WORKBOOK",
    label: imported.filename,
    sourceHash: imported.sourceHash,
    normalized: imported.normalized,
    metadata: imported.metadata,
  };
}

function selectedItemIds(tasks) {
  const selected = normalizeSelectedTasks(tasks);
  return new Set(selected.flatMap((task) => {
    const registry = getConfigurationItem(task);
    return [
      registry.id,
      task.code,
      task.name,
      String(task.name || "").toLowerCase(),
      String(task.code || "").toLowerCase(),
    ].filter(Boolean);
  }));
}

function filterRecords(records, selectedIds) {
  if (!selectedIds.size) return records;
  return records.filter((record) =>
    selectedIds.has(record.configurationItem) ||
    selectedIds.has(record.configurationName) ||
    selectedIds.has(String(record.configurationName || "").toLowerCase()) ||
    selectedIds.has(String(record.configurationItem || "").toLowerCase())
  );
}

function operationFromComparison(result) {
  if (result.status === "REMOVED") return "CREATE";
  if (result.status === "MODIFIED") return "UPDATE";
  if (result.status === "UNCHANGED") return "NO_CHANGE";
  if (result.status === "ADDED") return "SKIP_DESTINATION_ONLY";
  return "UNSUPPORTED";
}

async function buildImportCapabilities(tasks, source, destinationClient) {
  const capabilities = new Map();
  for (const task of normalizeSelectedTasks(tasks)) {
    const registry = getConfigurationItem(task);
    const packageInfo = (source.oraclePackages || []).find((item) =>
      String(item.taskCode || "").toUpperCase() === String(task.code || registry.id).toUpperCase()
    );
    let capability;
    if (!packageInfo) {
      capability = {
        supported: false,
        reason: source.type === "WORKBOOK"
          ? "Automated Oracle import requires an Existing Extraction containing the original Oracle task package; uploaded Excel workbooks are preview-only."
          : "This extraction does not contain the original Oracle task package. Generate a new Config Snapshot after deploying the migration automation update.",
      };
    } else {
      const oracleSupport = await checkTaskImportSupported(destinationClient, task.code || packageInfo.taskCode);
      capability = { ...oracleSupport, packageInfo, taskCode: task.code || packageInfo.taskCode, taskName: task.name };
    }
    for (const id of [registry.id, task.code, task.name]) {
      if (id) capabilities.set(String(id).toUpperCase(), capability);
    }
  }
  return capabilities;
}

async function buildOperations(comparison, importCapabilities = new Map()) {
  const operations = [];
  const blockingErrors = [];
  const blockedItems = new Set();
  for (const [index, result] of comparison.results.entries()) {
    const desired = operationFromComparison(result);
    const registry = getConfigurationItem({ name: result.configurationName, code: result.configurationItem }, {
      functionalArea: { name: result.source?.metadata?.functionalArea || result.target?.metadata?.functionalArea },
      module: result.source?.metadata?.module || result.target?.metadata?.module,
    }, Object.keys(result.source?.fields || result.target?.fields || {}));
    const operation = {
      id: `${result.configurationItem}-${index}`,
      operation: desired,
      configurationItem: result.configurationItem,
      configurationName: result.configurationName,
      dataset: result.dataset,
      recordKey: result.recordKey,
      source: result.source,
      target: result.target,
      changes: result.changes || [],
      dependencyOrder: registry.migration?.dependencyOrder || 100,
      reason: desired === "SKIP_DESTINATION_ONLY" ? "Destination-only record; deletes are disabled by default." : "",
      migrationSupported: registry.migrationSupported === true,
    };
    const capability = importCapabilities.get(String(result.configurationItem || "").toUpperCase())
      || importCapabilities.get(String(result.configurationName || "").toUpperCase());
    const validation = capability?.supported
      ? { ok: true }
      : capability
        ? { ok: false, code: "MIGRATION_NOT_SUPPORTED", message: capability.reason }
        : await validateMigration(operation);
    if (["CREATE", "UPDATE"].includes(desired) && !validation.ok) {
      operation.operation = "UNSUPPORTED";
      operation.reason = validation.message;
      operation.migrationSupported = false;
      const blockerKey = String(result.configurationItem || result.configurationName);
      if (!blockedItems.has(blockerKey)) {
        blockedItems.add(blockerKey);
        blockingErrors.push({
          code: validation.code || "MIGRATION_NOT_SUPPORTED",
          configurationItem: result.configurationItem,
          configurationName: result.configurationName,
          recordKey: result.recordKey,
          message: validation.message,
        });
      }
    } else if (["CREATE", "UPDATE"].includes(desired) && capability?.supported) {
      operation.migrationSupported = true;
      operation.importTaskCode = capability.taskCode;
      operation.importTaskName = capability.taskName;
    }
    operations.push(operation);
  }
  operations.sort((left, right) => (left.dependencyOrder - right.dependencyOrder)
    || String(left.configurationName).localeCompare(String(right.configurationName))
    || String(left.recordKey).localeCompare(String(right.recordKey)));
  return { operations, blockingErrors };
}

function buildPackageFallbackOperations(tasks, importCapabilities, extractionFailures) {
  const operations = [];
  const blockingErrors = [];
  for (const [index, task] of normalizeSelectedTasks(tasks).entries()) {
    const capability = importCapabilities.get(String(task.code || "").toUpperCase())
      || importCapabilities.get(String(task.name || "").toUpperCase());
    if (!capability?.supported || !capability.packageInfo) {
      const message = capability?.reason || `Oracle import support could not be verified for ${task.name}.`;
      blockingErrors.push({
        code: "MIGRATION_NOT_SUPPORTED",
        configurationItem: task.code,
        configurationName: task.name,
        message,
      });
      operations.push({
        id: `package-${index}`,
        operation: "UNSUPPORTED",
        configurationItem: task.code,
        configurationName: task.name,
        dataset: "Oracle setup task package",
        recordKey: task.code,
        changes: [],
        dependencyOrder: 100,
        reason: message,
        migrationSupported: false,
      });
      continue;
    }
    operations.push({
      id: `package-${index}`,
      operation: "UPDATE",
      configurationItem: task.code,
      configurationName: task.name,
      dataset: "Oracle setup task package",
      recordKey: task.code,
      changes: [],
      dependencyOrder: 100,
      reason: "Destination record preview was unavailable. Oracle will validate and import the original task package as one guarded operation.",
      migrationSupported: true,
      importTaskCode: capability.taskCode,
      importTaskName: capability.taskName,
      destinationExtractionFailures: extractionFailures,
    });
  }
  return { operations, blockingErrors };
}

function summarizeOperations(operations, extra = {}) {
  const count = (operation) => operations.filter((item) => item.operation === operation).length;
  return {
    requested: operations.length,
    create: count("CREATE"),
    update: count("UPDATE"),
    noChange: count("NO_CHANGE"),
    skip: count("SKIP_DESTINATION_ONLY"),
    unsupported: count("UNSUPPORTED"),
    failed: extra.failed || 0,
    verified: extra.verified || 0,
    verificationFailed: extra.verificationFailed || 0,
  };
}

async function writePlanReport(plan) {
  const filename = `ConfigMigration_${safeFilename(plan.destination?.name)}_${Date.now()}.xlsx`;
  const outputPath = path.join(__dirname, "..", "output", filename);
  await buildMigrationWorkbook({ plan, outputPath });
  plan.reportFile = filename;
  await plan.save();
  return filename;
}

async function createMigrationPlan({ ownerId, requestedBy, body, sourceBuffer, sourceFilename }) {
  const startedAt = new Date();
  const baseCfg = loadConfig();
  const tasks = normalizeSelectedTasks(body.tasks);
  if (!tasks.length) throw new AppError("MIGRATION_PARAMETER_MISSING", "Select at least one configuration item for migration validation.");
  if (!body.destinationConnectionId) throw new AppError("MIGRATION_PARAMETER_MISSING", "Select a destination environment.");
  const context = {
    offering: body.offering || {},
    functionalArea: body.functionalArea || {},
    module: String(body.module || body.functionalArea?.name || ""),
    orgCodes: parseOrgCodes(body.orgCodes),
    allowDelete: false,
    allowRevisionMismatch: body.allowRevisionMismatch === true,
  };
  const destination = await authenticatedConnection(ownerId, body.destinationConnectionId, baseCfg);
  const isProd = String(destination.connection.environmentType || "").toUpperCase() === "PROD";
  const warnings = [];
  const blockingErrors = [];
  if (isProd) {
    blockingErrors.push({
      code: "PRODUCTION_MIGRATION_UNAUTHORIZED",
      message: "Production migration is blocked in this phase. Validate in DEV/SIT/UAT first and add explicit production approval controls before enabling execution.",
    });
  }
  if (isProd && context.allowRevisionMismatch) {
    blockingErrors.push({
      code: "PRODUCTION_MIGRATION_UNAUTHORIZED",
      message: "Oracle revision-mismatch override is not permitted for production destinations.",
    });
  }

  const source = sourceBuffer
    ? await loadUploadedWorkbook(sourceBuffer, { filename: sourceFilename }, context)
    : await loadExistingExtraction(ownerId, body.sourceRunId, context);

  const selectedIds = selectedItemIds(tasks);
  const sourceItems = filterRecords(source.normalized.items, selectedIds);
  if (!sourceItems.length) throw new AppError("INVALID_MIGRATION_SOURCE", "The source does not contain records for the selected configuration items.");

  const importCapabilities = await buildImportCapabilities(tasks, source, destination.client);

  const destinationExtraction = await extractConfigurationItems({
    client: destination.client,
    cfg: context.allowRevisionMismatch && !isProd
      ? { ...destination.cfg, taskExportTimeoutMs: Math.min(destination.cfg.taskExportTimeoutMs, 120000) }
      : destination.cfg,
    tasks,
    orgCodes: context.orgCodes.length ? context.orgCodes : destination.cfg.orgCodes,
  });
  const destinationFailures = destinationExtraction.taskResults.filter((task) => task.status === "failed");
  const destinationFailureDetails = destinationFailures.map((task) => ({
      code: task.code,
      name: task.name,
      errorMessage: task.errorMessage,
  }));
  if (destinationFailures.length && (!context.allowRevisionMismatch || isProd)) {
    throw new AppError(
      "DESTINATION_EXTRACTION_FAILED",
      `Destination extraction failed for ${destinationFailures.length} configuration item(s). Migration was not planned because missing destination data could be misclassified as CREATE.`,
      destinationFailureDetails
    );
  }
  let targetItems = [];
  let planned;
  if (destinationFailures.length) {
    warnings.push({
      code: "DESTINATION_PREVIEW_UNAVAILABLE",
      side: "DESTINATION",
      message: `Destination export remained unavailable for ${destinationFailures.length} configuration item(s). Using guarded Oracle task-package import because the non-production revision override was explicitly enabled.`,
      details: destinationFailureDetails,
    });
    planned = buildPackageFallbackOperations(tasks, importCapabilities, destinationFailureDetails);
  } else {
    const targetNormalized = normalizeExtraction(destinationExtraction.taskResults, {
      functionalArea: context.functionalArea,
      module: context.module,
      environmentName: destination.connection.name,
    });
    targetItems = filterRecords(targetNormalized.items, selectedIds);
    const comparison = compareConfigurations(sourceItems, targetItems);
    warnings.push(
      ...source.normalized.warnings.map((warning) => ({ ...warning, side: "SOURCE" })),
      ...targetNormalized.warnings.map((warning) => ({ ...warning, side: "DESTINATION" })),
      ...comparison.warnings
    );
    planned = await buildOperations(comparison, importCapabilities);
  }
  blockingErrors.push(...planned.blockingErrors);
  const summary = summarizeOperations(planned.operations);
  const planStatus = blockingErrors.length
    ? "BLOCKED"
    : summary.create + summary.update > 0
      ? "READY"
      : "COMPLETED";
  const planHash = makeHash({
    sourceHash: source.sourceHash,
    destinationId: destination.connection.id,
    context,
    tasks: tasks.map((task) => task.code || task.name),
    operations: planned.operations.map((operation) => ({
      operation: operation.operation,
      configurationItem: operation.configurationItem,
      dataset: operation.dataset,
      recordKey: operation.recordKey,
      changes: operation.changes,
    })),
  });
  const plan = await MigrationPlan.create({
    ownerId,
    status: planStatus,
    source: { type: source.type, id: source.id || "", label: source.label, metadata: source.metadata, oraclePackages: source.oraclePackages || [] },
    destination: {
      id: destination.connection.id,
      name: destination.connection.name,
      environmentType: destination.connection.environmentType,
      baseUrl: destination.connection.baseUrl,
    },
    context,
    requestedItems: tasks.map((task) => task.code || task.name),
    sourceHash: source.sourceHash,
    planHash,
    preMigrationSnapshot: {
      capturedAt: new Date().toISOString(),
      destinationConnectionId: destination.connection.id,
      recordCount: targetItems.length,
      extractionTaskCount: destinationExtraction.taskResults.length,
      extractionFailures: destinationExtraction.taskResults.filter((task) => task.status === "failed").map((task) => ({ code: task.code, name: task.name, errorMessage: task.errorMessage })),
    },
    summary,
    operations: planned.operations,
    warnings,
    blockingErrors,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  await writePlanReport(plan);
  const history = await RunHistory.create({
    ownerId,
    operation: "MIGRATION",
    lifecycleStatus: plan.status,
    requestedBy,
    targetConnection: plan.destination,
    offeringCode: context.offering.code || "",
    offeringName: context.offering.name || "",
    functionalAreaCode: context.functionalArea.code || "",
    functionalAreaName: context.functionalArea.name || "",
    configurationItems: plan.requestedItems,
    parameters: { orgCodes: context.orgCodes, source: plan.source, planId: plan.id },
    resultSummary: plan.summary,
    warnings: warnings.slice(0, 100),
    startedAt,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    taskCount: tasks.length,
    recordCount: sourceItems.length,
    outputFile: plan.reportFile,
    status: ["READY", "COMPLETED"].includes(plan.status) ? "success" : "failed",
    errorMessage: blockingErrors.length ? `${blockingErrors.length} blocking migration validation errors.` : null,
  });
  plan.historyRunId = history.id;
  await plan.save();
  await writeAudit({ ownerId, action: "MIGRATION_PREVIEWED", metadata: { migrationId: plan.id, status: plan.status, summary: plan.summary, outputFile: plan.reportFile } });
  return plan;
}

async function executeMigrationPlan({ ownerId, planId, confirmationText }) {
  const plan = await MigrationPlan.findOne({ _id: planId, ownerId }).select("+ownerId");
  if (!plan) throw new AppError("INVALID_MIGRATION_SOURCE", "Migration plan was not found for this user.");
  if (plan.expiresAt < new Date()) throw new AppError("MIGRATION_PLAN_EXPIRED", "Migration plan expired. Validate again before executing.");
  if (!["READY", "PARTIALLY_COMPLETED", "FAILED"].includes(plan.status)) {
    throw new AppError("MIGRATION_VALIDATION_FAILED", "This migration plan is not ready for execution.");
  }
  const expectedText = `MIGRATE TO ${plan.destination.name}`;
  if (confirmationText !== expectedText) {
    throw new AppError("MIGRATION_VALIDATION_FAILED", `Type exactly "${expectedText}" to execute this migration.`);
  }
  const executable = plan.operations.filter((operation) => ["CREATE", "UPDATE"].includes(operation.operation) && operation.importTaskCode);
  if (!executable.length) {
    throw new AppError(
      "MIGRATION_NOT_SUPPORTED",
      "This plan has no executable Oracle imports. Use an Automation ready extraction and select a task that Oracle reports as CSV-import supported."
    );
  }
  if (String(plan.destination.environmentType || "").toUpperCase() === "PROD" && plan.context?.allowRevisionMismatch) {
    throw new AppError(
      "PRODUCTION_MIGRATION_UNAUTHORIZED",
      "Oracle revision-mismatch override is not permitted for production destinations."
    );
  }
  plan.status = "RUNNING";
  plan.startedAt = new Date();
  await plan.save();
  const grouped = new Map();
  for (const operation of executable) {
    const key = String(operation.importTaskCode).toUpperCase();
    const group = grouped.get(key) || [];
    group.push(operation);
    grouped.set(key, group);
  }
  const taskGroups = Array.from(grouped.entries());
  startMigrationProgress(plan.id, { phase: "running", totalItems: taskGroups.length, message: "Importing Oracle setup task packages..." });
  const baseCfg = loadConfig();
  const destination = await authenticatedConnection(ownerId, plan.destination.id, baseCfg);
  const executionResults = [];
  for (const [index, [taskCode, operations]] of taskGroups.entries()) {
    try {
      const packageInfo = (plan.source?.oraclePackages || []).find((item) => String(item.taskCode || "").toUpperCase() === taskCode);
      if (!packageInfo) throw new Error(`The original Oracle package for ${taskCode} is unavailable.`);
      const packageBuffer = await readTaskPackage(packageInfo);
      const result = await importTaskPackage(destination.client, destination.cfg, taskCode, packageBuffer, {
        allowRevisionMismatch: plan.context?.allowRevisionMismatch === true,
        onStatus: ({ processId, status }) => updateMigrationProgress(plan.id, {
          currentItem: operations[0]?.configurationName || taskCode,
          oracleProcessId: processId,
          oracleStatus: status,
          message: `Oracle import for ${operations[0]?.configurationName || taskCode}: ${status}`,
        }),
      });
      executionResults.push(...operations.map((operation) => ({ ...operation, status: "SUCCESS", result: { processId: result.processId, status: result.status } })));
    } catch (error) {
      executionResults.push(...operations.map((operation) => ({ ...operation, status: "FAILED", errorCode: error.code || "MIGRATION_EXECUTION_FAILED", errorMessage: error.message })));
    }
    updateMigrationProgress(plan.id, {
      completedItems: index + 1,
      successfulItems: taskGroups.slice(0, index + 1).filter(([code]) => executionResults.some((item) => String(item.importTaskCode).toUpperCase() === code && item.status === "SUCCESS")).length,
      failedItems: taskGroups.slice(0, index + 1).filter(([code]) => executionResults.some((item) => String(item.importTaskCode).toUpperCase() === code && item.status === "FAILED")).length,
    });
  }
  const failed = executionResults.filter((item) => item.status === "FAILED").length;
  const succeeded = executionResults.filter((item) => item.status === "SUCCESS").length;
  plan.executionResults = executionResults;
  plan.summary = summarizeOperations(plan.operations, { failed });
  plan.status = failed === 0
    ? "COMPLETED"
    : succeeded > 0
      ? "PARTIALLY_COMPLETED"
      : "FAILED";
  plan.completedAt = new Date();
  await writePlanReport(plan);
  await plan.save();
  await RunHistory.updateOne({ _id: plan.historyRunId, ownerId }, {
    lifecycleStatus: plan.status,
    status: plan.status === "COMPLETED" ? "success" : plan.status === "PARTIALLY_COMPLETED" ? "partial" : "failed",
    resultSummary: plan.summary,
    outputFile: plan.reportFile,
    completedAt: plan.completedAt,
    errorMessage: failed ? `${failed} migration operations failed.` : null,
  }).catch(() => {});
  const auditAction = plan.status === "COMPLETED"
    ? "MIGRATION_COMPLETED"
    : plan.status === "PARTIALLY_COMPLETED"
      ? "MIGRATION_PARTIAL"
      : "MIGRATION_FAILED";
  await writeAudit({ ownerId, action: auditAction, status: plan.status, metadata: { migrationId: plan.id, summary: plan.summary, outputFile: plan.reportFile } });
  updateMigrationProgress(plan.id, {
    phase: plan.status.toLowerCase(),
    message: plan.status === "COMPLETED"
      ? "Migration completed successfully in Oracle."
      : plan.status === "PARTIALLY_COMPLETED"
        ? "Migration completed with some failed operations."
        : "Migration failed; Oracle did not complete any import operation.",
  });
  return plan;
}

module.exports = { createMigrationPlan, executeMigrationPlan, listMigrationSources };
