const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkTaskImportSupported,
  importTaskPackage,
  startTaskImport,
} = require("../src/setupTaskImportService");

test("Oracle task import support recognizes enabled and disabled tasks", async () => {
  const enabled = await checkTaskImportSupported({
    get: async () => ({ status: 200, data: { ImportSupportedFlag: "Y" } }),
  }, "TASK_A");
  const disabled = await checkTaskImportSupported({
    get: async () => ({ status: 200, data: { ImportSupportedFlag: "N" } }),
  }, "TASK_B");
  assert.equal(enabled.supported, true);
  assert.equal(disabled.supported, false);
});

test("task import sends the original Oracle ZIP as base64", async () => {
  let request;
  const processId = await startTaskImport({
    post: async (url, body) => {
      request = { url, body };
      return { status: 201, data: { SetupTaskCSVImportProcess: [{ ProcessId: 123 }] } };
    },
  }, "TASK_A", Buffer.from("oracle-package"));

  assert.equal(processId, 123);
  assert.equal(request.url.endsWith("/setupTaskCSVImports"), true);
  assert.equal(request.body.TaskCode, "TASK_A");
  assert.equal(request.body.SetupTaskCSVImportProcess[0].SourceTargetDiffOkFlag, "N");
  assert.equal(
    Buffer.from(request.body.SetupTaskCSVImportProcess[0].FileContent, "base64").toString(),
    "oracle-package"
  );
});

test("task import explicitly allows a non-production revision mismatch override", async () => {
  let request;
  await startTaskImport({
    post: async (url, body) => {
      request = { url, body };
      return { status: 201, data: { ProcessId: 321 } };
    },
  }, "TASK_A", Buffer.from("oracle-package"), { allowRevisionMismatch: true });

  assert.equal(request.body.SetupTaskCSVImportProcess[0].SourceTargetDiffOkFlag, "Y");
});

test("task import completes after Oracle reports a completed result", async () => {
  const client = {
    post: async () => ({ status: 201, data: { ProcessId: 456 } }),
    get: async (url) => ({
      status: 200,
      data: url.includes("SetupTaskCSVImportProcessResult")
        ? { StatusCode: "COMPLETED" }
        : { ProcessCompletedFlag: "Y" },
    }),
  };
  const result = await importTaskPackage(client, {
    taskExportTimeoutMs: 1000,
    taskExportPollMs: 1,
  }, "TASK_A", Buffer.from("oracle-package"));
  assert.equal(result.processId, 456);
  assert.equal(result.status, "COMPLETED");
});
