const assert = require("node:assert/strict");
const test = require("node:test");
const {
  diagnosticMessage,
  fetchImportDiagnostics,
  importTaskPackage,
  summarizeDiagnosticReports,
} = require("../src/setupTaskImportService");

test("Oracle import diagnostics download and expose the process log", async () => {
  const client = {
    get: async (path) => path.includes("ProcessLog")
      ? { status: 200, data: Buffer.from("Business unit TID already exists in the target configuration.") }
      : { status: 404, data: {} },
  };
  const reports = await fetchImportDiagnostics(client, "/result/123");
  assert.equal(reports.length, 1);
  assert.match(diagnosticMessage(reports), /already exists/);
});

test("Oracle diagnostics summarize the root Business Unit prerequisite failure", () => {
  const summary = summarizeDiagnosticReports([{ name: "ProcessResultsReport", text:
    "A primary ledger is required if any selected functions generate financial transactions. " +
    "Applying List binding LOV_DefaultSetCode leads to no matching row. " +
    "Attribute OrgInformation4 in BusinessUnitDetailEO is required. " +
    "PER_AOR_BUS_UNIT Message Text: The business unit doesn't exist. " +
    "Environment: etaj Revision: 11.13.26.07.0 The configuration package X was generated using setup data from environment etpk-dev3 with 11.13.26.04.0 revision."
  }]);
  assert.match(summary, /primary ledger is required/i);
  assert.match(summary, /reference data set/i);
  assert.match(summary, /OrgInformation4/);
  assert.match(summary, /Business Unit was not created/);
  assert.match(summary, /source 11\.13\.26\.04\.0, destination 11\.13\.26\.07\.0/);
});

test("completed-with-errors includes Oracle diagnostics in the thrown error", async () => {
  const client = {
    post: async () => ({ status: 200, data: { SetupTaskCSVImportProcess: [{ ProcessId: 123 }] } }),
    get: async (path) => {
      if (path.endsWith("/enclosure/ProcessLog")) return { status: 200, data: Buffer.from("Invalid reference data set assignment.") };
      if (path.includes("SetupTaskCSVImportProcessResult/123")) return { status: 200, data: { StatusCode: "COMPLETED_ERRORS" } };
      return { status: 200, data: { StatusCode: "COMPLETED_ERRORS" } };
    },
  };
  await assert.rejects(
    () => importTaskPackage(client, { taskExportTimeoutMs: 1000, taskExportPollMs: 1 }, "FUN_MANAGE_BUSINESS_UNIT", Buffer.from("package")),
    (error) => {
      assert.equal(error.code, "ORACLE_IMPORT_COMPLETED_ERRORS");
      assert.match(error.message, /Invalid reference data set assignment/);
      assert.equal(error.details.processId, 123);
      return true;
    }
  );
});
