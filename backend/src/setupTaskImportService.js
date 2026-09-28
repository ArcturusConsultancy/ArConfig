const COMPLETED_STATUSES = new Set(["COMPLETED", "COMPLETED_WARNINGS", "COMPLETED_ERRORS"]);

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertResponse(response, operation) {
  if (response?.status >= 200 && response.status < 300) return;
  const preview = JSON.stringify(response?.data || {}).slice(0, 500);
  const error = new Error(`${operation} failed with HTTP ${response?.status || "unknown"}. ${preview}`);
  error.status = response?.status || 500;
  throw error;
}

function readProcessId(data) {
  return data?.SetupTaskCSVImportProcess?.[0]?.ProcessId || data?.ProcessId;
}

async function checkTaskImportSupported(client, taskCode) {
  if (!taskCode) return { supported: false, reason: "The Oracle setup task has no task code." };
  try {
    const response = await client.get(
      `/fscmRestApi/resources/11.13.18.05/setupTaskCSVImports/${encodeURIComponent(taskCode)}`
    );
    assertResponse(response, `Checking import support for ${taskCode}`);
    const flag = response.data?.ImportSupportedFlag;
    const supported = flag === true || ["Y", "TRUE"].includes(String(flag || "").toUpperCase());
    return {
      supported,
      reason: supported ? "" : `Oracle reports that CSV import is not supported for task ${taskCode}.`,
    };
  } catch (error) {
    const status = error.status || error.response?.status;
    return {
      supported: false,
      reason: status === 404
        ? `Oracle does not expose a CSV import resource for task ${taskCode}.`
        : `Could not verify Oracle CSV import support for ${taskCode}: ${error.message}`,
    };
  }
}

async function startTaskImport(client, taskCode, packageBuffer, options = {}) {
  const processPayload = {
    TaskCode: taskCode,
    FileContent: packageBuffer.toString("base64"),
    SourceTargetDiffOkFlag: options.allowRevisionMismatch === true ? "Y" : "N",
  };
  const response = await client.post(
    "/fscmRestApi/resources/11.13.18.05/setupTaskCSVImports",
    {
      TaskCode: taskCode,
      SetupTaskCSVImportProcess: [processPayload],
    }
  );
  assertResponse(response, `Starting import for ${taskCode}`);
  let processId = readProcessId(response.data);
  if (processId) return processId;

  const childResponse = await client.post(
    `/fscmRestApi/resources/11.13.18.05/setupTaskCSVImports/${encodeURIComponent(taskCode)}` +
      "/child/SetupTaskCSVImportProcess",
    processPayload
  );
  assertResponse(childResponse, `Creating import process for ${taskCode}`);
  processId = readProcessId(childResponse.data);
  if (!processId) throw new Error(`Oracle did not return an import process ID for ${taskCode}.`);
  return processId;
}

async function pollTaskImport(client, cfg, taskCode, processId, onStatus) {
  const processPath =
    `/fscmRestApi/resources/11.13.18.05/setupTaskCSVImports/${encodeURIComponent(taskCode)}` +
    `/child/SetupTaskCSVImportProcess/${processId}`;
  const resultPath = `${processPath}/child/SetupTaskCSVImportProcessResult/${processId}`;
  const deadline = Date.now() + cfg.taskExportTimeoutMs;
  let status = "NOT_STARTED";
  let reportedStatus = "";
  let processData = {};
  let resultData = {};

  while (Date.now() < deadline) {
    const processResponse = await client.get(processPath);
    assertResponse(processResponse, `Checking import for ${taskCode}`);
    processData = processResponse.data || {};
    status = processData.StatusCode || status;

    try {
      const resultResponse = await client.get(resultPath);
      assertResponse(resultResponse, `Checking import result for ${taskCode}`);
      resultData = resultResponse.data || {};
      status = resultData.StatusCode || status;
    } catch (error) {
      if (error.status !== 404 && error.response?.status !== 404) throw error;
    }

    if (COMPLETED_STATUSES.has(status)) {
      if (onStatus && status !== reportedStatus) onStatus({ processId, status });
      return { processId, status, processData, resultData };
    }
    if (onStatus && status !== reportedStatus) {
      reportedStatus = status;
      onStatus({ processId, status });
    }
    await wait(cfg.taskExportPollMs);
  }
  throw new Error(`Oracle did not finish importing ${taskCode} before the configured timeout. Last status: ${status}.`);
}

async function importTaskPackage(client, cfg, taskCode, packageBuffer, options = {}) {
  if (!Buffer.isBuffer(packageBuffer) || !packageBuffer.length) {
    throw new Error(`The original Oracle export package for ${taskCode} is unavailable.`);
  }
  const processId = await startTaskImport(client, taskCode, packageBuffer, options);
  if (options.onStatus) options.onStatus({ processId, status: "SUBMITTED" });
  const result = await pollTaskImport(client, cfg, taskCode, processId, options.onStatus);
  if (result.status === "COMPLETED_ERRORS") {
    const error = new Error(`Oracle completed the import for ${taskCode} with errors.`);
    error.code = "ORACLE_IMPORT_COMPLETED_ERRORS";
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  checkTaskImportSupported,
  importTaskPackage,
  pollTaskImport,
  readProcessId,
  startTaskImport,
};
