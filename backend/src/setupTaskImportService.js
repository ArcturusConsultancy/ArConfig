const COMPLETED_STATUSES = new Set(["COMPLETED", "COMPLETED_WARNINGS", "COMPLETED_ERRORS"]);
const REPORT_NAMES = ["ProcessLog", "ProcessResultsSummaryReport", "ProcessResultsReport"];

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

function responseBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return Buffer.from(data);
  return Buffer.alloc(0);
}

function readableReportText(buffer) {
  if (!buffer?.length) return "";
  const text = buffer.toString("utf8")
    .replace(/\\r\\n|\\n|\\r/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const printable = Array.from(text).filter((character) => character >= " " && character <= "~").length;
  return printable / Math.max(text.length, 1) >= 0.65 ? text.slice(0, 4000) : "";
}

function summarizeDiagnosticReports(reports) {
  const text = reports.map((report) => report.text || "").join(" ");
  if (!text) return "";
  const details = [];
  const primaryLedger = text.match(/A primary ledger is required[^.]*\./i)?.[0];
  if (primaryLedger) details.push(primaryLedger);
  if (/LOV_DefaultSetCode[^.]*no matching row/i.test(text)) {
    details.push("The destination could not resolve the source default reference data set.");
  }
  const requiredAttribute = text.match(/Attribute\s+([A-Za-z0-9_]+)[^.]*is required/i)?.[1];
  if (requiredAttribute) details.push(`Oracle also reported missing required attribute ${requiredAttribute}.`);
  const businessUnitMissing = /PER_AOR_BUS_UNIT[\s\S]*?business unit doesn't exist/i.test(text);
  if (businessUnitMissing) {
    details.push("Dependent Business Unit assignments failed because the Business Unit was not created.");
  }
  const revision = text.match(/generated using setup data from environment\s+([^\s]+)\s+with\s+([^\s]+)\s+revision/i);
  const targetRevision = text.match(/Environment:\s*([^\s]+)\s+Revision:\s*([^\s]+)/i);
  if (revision && targetRevision && revision[2] !== targetRevision[2]) {
    details.push(`Oracle revision mismatch: source ${revision[2]}, destination ${targetRevision[2]}.`);
  }
  if (details.length) return [...new Set(details)].join(" ");
  const messageText = text.match(/Message Text:\s*(.*?)(?:The data row|Row Identifier:|$)/i)?.[1]?.trim();
  return messageText ? messageText.slice(0, 1000) : "";
}

async function fetchImportDiagnostics(client, resultPath) {
  const reports = [];
  for (const name of REPORT_NAMES) {
    try {
      const response = await client.get(`${resultPath}/enclosure/${name}`, {
        responseType: "arraybuffer",
        headers: { Accept: "application/octet-stream" },
      });
      if (response?.status < 200 || response.status >= 300) continue;
      const buffer = responseBuffer(response.data);
      if (!buffer.length) continue;
      reports.push({ name, size: buffer.length, text: readableReportText(buffer) });
    } catch (_) {
      // Diagnostics are best-effort and must not mask the actual Oracle status.
    }
  }
  return reports;
}

function diagnosticMessage(reports) {
  const summary = summarizeDiagnosticReports(reports);
  if (summary) return summary;
  const preferred = reports.find((report) => report.name === "ProcessLog" && report.text)
    || reports.find((report) => report.text);
  return preferred?.text?.slice(0, 1000) || "Oracle returned COMPLETED_ERRORS. See the Oracle Details sheet in the migration report.";
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
      const reports = await fetchImportDiagnostics(client, resultPath);
      if (onStatus && status !== reportedStatus) onStatus({ processId, status });
      return { processId, status, processData, resultData, reports };
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
    const detail = diagnosticMessage(result.reports || []);
    const error = new Error(`Oracle completed the import for ${taskCode} with errors. ${detail}`);
    error.code = "ORACLE_IMPORT_COMPLETED_ERRORS";
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  checkTaskImportSupported,
  diagnosticMessage,
  fetchImportDiagnostics,
  importTaskPackage,
  pollTaskImport,
  readProcessId,
  startTaskImport,
  summarizeDiagnosticReports,
};
