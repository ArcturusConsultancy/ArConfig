const crypto = require("crypto");
const { getConfigurationItem } = require("./configurationRegistry");

const AUDIT_FIELDS = /^(createdby|creationdate|lastupdatedby|lastupdatedate|lastupdatelogin)$/i;
const SENSITIVE_FIELDS = /password|secret|access.?token|refresh.?token|private.?key|credential/i;

function normalizeHeader(value, index) {
  return String(value ?? "").trim() || `Column ${index + 1}`;
}

function rowObject(headers, row, ignoredFields = []) {
  const result = {};
  const ignored = new Set(ignoredFields);
  headers.forEach((header, index) => {
    if (!AUDIT_FIELDS.test(header) && !SENSITIVE_FIELDS.test(header) && !ignored.has(header)) {
      result[header] = row?.[index] ?? "";
    }
  });
  return result;
}

function stableValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value, Object.keys(value).sort());
  return String(value).trim();
}

function keyFor(fields, comparisonKeys) {
  const values = comparisonKeys.map((key) => stableValue(fields[key]));
  if (values.some(Boolean)) return values.join(" | ");
  const canonical = Object.keys(fields).sort().map((key) => `${key}=${stableValue(fields[key])}`).join("|");
  return `ROW_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function normalizeTaskResult(taskResult, context = {}) {
  const records = [];
  const warnings = [];
  for (const file of taskResult.files || []) {
    const table = Array.isArray(file.rows) ? file.rows : [];
    if (!table.length) continue;
    const headers = table[0].map(normalizeHeader);
    const dataset = String(file.name || "Data").replace(/\.csv$/i, "");
    const registryItem = getConfigurationItem(taskResult, { ...context, dataset }, headers);
    for (const rawRow of table.slice(1)) {
      const fields = rowObject(headers, rawRow, registryItem.ignoredFields);
      records.push({
        configurationItem: registryItem.id,
        configurationName: registryItem.displayName,
        dataset,
        recordKey: keyFor(fields, registryItem.comparisonKeys),
        businessUnit: fields["Business Unit"] || fields["Organization Code"] || fields.Organization || "",
        fields,
        comparisonRules: registryItem.comparisonRules,
        metadata: {
          sourceEnvironment: context.environmentName || "",
          functionalArea: registryItem.functionalArea,
          module: registryItem.module,
          comparisonKeys: registryItem.comparisonKeys,
        },
      });
    }
    if (!registryItem.comparisonKeys.length) {
      warnings.push({ code: "BAD_COMPARISON_KEY", configurationItem: registryItem.id, dataset: file.name });
    }
  }
  return { records, warnings };
}

function normalizeExtraction(taskResults, context = {}) {
  const result = { items: [], warnings: [] };
  for (const taskResult of taskResults || []) {
    if (taskResult.status === "failed") {
      result.warnings.push({ code: "EXTRACTION_FAILED", configurationItem: taskResult.code || taskResult.name, message: taskResult.errorMessage });
      continue;
    }
    const normalized = normalizeTaskResult(taskResult, context);
    result.items.push(...normalized.records);
    result.warnings.push(...normalized.warnings);
  }
  return result;
}

module.exports = { keyFor, normalizeExtraction, normalizeTaskResult, stableValue };
