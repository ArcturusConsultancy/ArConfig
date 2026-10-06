const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const { normalizeCellValue, safeSheetName } = require("./excelWriter");
const { displayFieldName } = require("./comparisonReport");

const COLORS = {
  title: "FF1F4E78",
  header: "FFF8CBAD",
  create: "FFE2F0D9",
  update: "FFFFF2CC",
  skip: "FFE7EEF7",
  unsupported: "FFFCE4D6",
  fail: "FFF4CCCC",
  border: "FFD9E2EC",
  text: "FF17324D",
  white: "FFFFFFFF",
};

const BORDER = {
  top: { style: "thin", color: { argb: COLORS.border } },
  left: { style: "thin", color: { argb: COLORS.border } },
  bottom: { style: "thin", color: { argb: COLORS.border } },
  right: { style: "thin", color: { argb: COLORS.border } },
};

function fill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function styleHeader(row) {
  row.height = 21;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.text } };
    cell.fill = fill(COLORS.header);
    cell.border = BORDER;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
}

function styleRow(row, statusColumn = 1) {
  row.eachCell((cell, columnNumber) => {
    cell.border = BORDER;
    cell.alignment = { vertical: "top", wrapText: true };
    if (columnNumber === statusColumn) {
      const value = String(cell.value || "").toUpperCase();
      const color = value.includes("CREATE") ? COLORS.create
        : value.includes("UPDATE") ? COLORS.update
          : value.includes("UNSUPPORTED") ? COLORS.unsupported
            : value.includes("FAILED") || value.includes("ERROR") ? COLORS.fail
              : value.includes("SKIP") || value.includes("NO_CHANGE") ? COLORS.skip
                : "";
      if (color) cell.fill = fill(color);
    }
  });
}

function addTitle(sheet, title, columnCount) {
  const row = sheet.addRow([title]);
  sheet.mergeCells(row.number, 1, row.number, Math.max(1, columnCount));
  row.height = 24;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white }, size: 13 };
    cell.fill = fill(COLORS.title);
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
}

function autoFit(sheet) {
  for (let index = 1; index <= Math.max(sheet.columnCount, 1); index += 1) {
    const column = sheet.getColumn(index);
    let width = 12;
    column.eachCell({ includeEmpty: false }, (cell) => {
      width = Math.max(width, Math.min(58, String(cell.value ?? "").length + 2));
    });
    column.width = width;
  }
}

function addTable(sheet, title, headers, rows, options = {}) {
  addTitle(sheet, title, headers.length);
  sheet.addRow([]);
  const header = sheet.addRow(headers);
  styleHeader(header);
  rows.forEach((row) => styleRow(sheet.addRow(row.map(normalizeCellValue)), options.statusColumn || 1));
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  if (rows.length) {
    sheet.autoFilter = {
      from: { row: header.number, column: 1 },
      to: { row: header.number, column: headers.length },
    };
  }
  autoFit(sheet);
}

function operationRows(plan, types) {
  return (plan.operations || [])
    .filter((operation) => types.includes(operation.operation))
    .flatMap((operation) => {
      if (operation.operation === "UPDATE" && Array.isArray(operation.changes) && operation.changes.length) {
        return operation.changes.map((change) => [
          operation.configurationName,
          operation.recordKey,
          operation.operation,
          operation.dataset,
          displayFieldName(change.field),
          change.targetValue,
          change.sourceValue,
          operation.reason || "",
        ]);
      }
      return [[
        operation.configurationName,
        operation.recordKey,
        operation.operation,
        operation.dataset,
        "",
        operation.target ? "Present" : "",
        operation.source ? "Present" : "",
        operation.reason || "",
      ]];
    });
}

async function buildMigrationWorkbook({ plan, outputPath }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ConfigSnapshot";
  workbook.created = new Date();

  addTable(workbook.addWorksheet("SUMMARY"), "Migration Summary", ["Field", "Value"], [
    ["Migration ID", plan.id || plan._id || ""],
    ["Source", plan.source?.label || plan.source?.type || ""],
    ["Destination", plan.destination?.name || ""],
    ["Functional Area", plan.context?.functionalArea?.name || ""],
    ["Module", plan.context?.module || ""],
    ["Business Unit / Scope", (plan.context?.orgCodes || []).join(", ")],
    ["Status", plan.status],
    ["Created", plan.summary?.create || 0],
    ["Updated", plan.summary?.update || 0],
    ["Unchanged", plan.summary?.noChange || 0],
    ["Skipped", plan.summary?.skip || 0],
    ["Unsupported", plan.summary?.unsupported || 0],
    ["Failed", plan.summary?.failed || 0],
    ["Warnings", (plan.warnings || []).length],
    ["Blocking Errors", (plan.blockingErrors || []).length],
  ], { statusColumn: 0 });

  addTable(workbook.addWorksheet("VALIDATION"), "Validation Messages", ["Severity", "Code", "Configuration Item", "Record Key", "Message"], [
    ...(plan.blockingErrors || []).map((error) => ["ERROR", error.code, error.configurationName || error.configurationItem || "", error.recordKey || "", error.message]),
    ...(plan.warnings || []).map((warning) => ["WARNING", warning.code, warning.configurationName || warning.configurationItem || "", warning.recordKey || "", warning.message || ""]),
  ]);

  addTable(workbook.addWorksheet("CREATED"), "Records To Create", ["Configuration Item", "Record Key", "Operation", "Dataset", "Field", "Destination Value", "Source Value", "Reason"], operationRows(plan, ["CREATE"]));
  addTable(workbook.addWorksheet("UPDATED"), "Records To Update", ["Configuration Item", "Record Key", "Operation", "Dataset", "Field", "Current Value", "New Value", "Reason"], operationRows(plan, ["UPDATE"]));
  addTable(workbook.addWorksheet("SKIPPED"), "Skipped / Unchanged Records", ["Configuration Item", "Record Key", "Operation", "Dataset", "Field", "Destination Value", "Source Value", "Reason"], operationRows(plan, ["NO_CHANGE", "SKIP_DESTINATION_ONLY"]));
  const failedItems = (plan.executionResults || []).filter((item) => item.status === "FAILED");
  addTable(workbook.addWorksheet("FAILED"), "Failed Operations", ["Configuration Item", "Record Key", "Operation", "Error Code", "Error Message", "Oracle Process ID", "Oracle Status"], failedItems.map((item) => [item.configurationName, item.recordKey, item.operation, item.errorCode, item.errorMessage, item.oracleProcessId || "", item.oracleStatus || ""]));
  const oracleReports = [];
  const seenReports = new Set();
  for (const item of failedItems) {
    for (const report of item.oracleReports || []) {
      const key = `${item.importTaskCode || item.configurationName}:${item.oracleProcessId || ""}:${report.name}`;
      if (seenReports.has(key)) continue;
      seenReports.add(key);
      oracleReports.push([
        item.configurationName,
        item.importTaskCode || "",
        item.oracleProcessId || "",
        item.oracleStatus || "",
        report.name || "",
        report.text || "Binary Oracle report captured; use the encoded content if detailed inspection is required.",
      ]);
    }
  }
  if (oracleReports.length) {
    addTable(workbook.addWorksheet("ORACLE DETAILS"), "Oracle Import Diagnostics", ["Configuration Item", "Task Code", "Process ID", "Oracle Status", "Report", "Details"], oracleReports);
  }
  addTable(workbook.addWorksheet("VERIFICATION"), "Post-Migration Verification", ["Configuration Item", "Record Key", "Expected Value", "Actual Value", "Verification Status"], (plan.verification?.results || []).map((item) => [item.configurationName, item.recordKey, item.expectedValue || "", item.actualValue || "", item.status]));

  const unsupported = operationRows(plan, ["UNSUPPORTED"]);
  if (unsupported.length) {
    addTable(workbook.addWorksheet(safeSheetName("UNSUPPORTED")), "Unsupported Migration Items", ["Configuration Item", "Record Key", "Operation", "Dataset", "Field", "Destination Value", "Source Value", "Reason"], unsupported);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { buildMigrationWorkbook };
