const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTaskResult } = require("../src/normalizationService");
const { inferComparisonKeys } = require("../src/configurationRegistry");

test("normalization converts CSV tables and removes audit fields", () => {
  const normalized = normalizeTaskResult({
    name: "Example Configuration",
    code: "EXAMPLE",
    files: [{ name: "Example.csv", rows: [["Code", "Value", "CreatedBy", "AccessToken"], ["A", "One", "ADMIN", "secret"]] }],
  }, { environmentName: "DEV", functionalArea: { name: "Finance" } });
  assert.equal(normalized.records.length, 1);
  assert.equal(normalized.records[0].recordKey, "A");
  assert.deepEqual(normalized.records[0].fields, { Code: "A", Value: "One" });
  assert.equal(normalized.records[0].metadata.sourceEnvironment, "DEV");
});

test("registry infers stable name/code keys", () => {
  assert.deepEqual(inferComparisonKeys(["Description", "Payment Term Name", "CreationDate"]), ["Payment Term Name"]);
  assert.deepEqual(inferComparisonKeys(["OrganizationId", "Description"]), ["OrganizationId"]);
  assert.deepEqual(inferComparisonKeys(["LookupType", "LookupCode", "Meaning"]), ["LookupType", "LookupCode"]);
  assert.deepEqual(inferComparisonKeys(["FND_APP_LOOKUP.LookupType", "LookupCode", "Meaning"]), ["FND_APP_LOOKUP.LookupType", "LookupCode"]);
});

test("Manage Business Unit uses unique cross-instance business keys for every Oracle dataset", () => {
  const normalized = normalizeTaskResult({
    name: "Manage Business Unit",
    code: "FUN_MANAGE_BUSINESS_UNIT",
    files: [
      {
        name: "FUN_BUSINESS_UNIT.csv",
        rows: [
          ["Name", "OrganizationCode", "DefaultSetCode"],
          ["TID", "SOURCE_INTERNAL_ID", "US1"],
        ],
      },
      {
        name: "FUN_BU_USAGE.csv",
        rows: [
          ["FUN_BUSINESS_UNIT.Name", "ModuleId", "ConfigurationStatus"],
          ["TID", "10", "Y"],
          ["TID", "20", "Y"],
        ],
      },
      {
        name: "FUN_BU_SERVICE_PROVIDERS.csv",
        rows: [
          ["ClientBuName", "ClientOrganizationCode", "ProviderBuName", "ProviderOrganizationCode", "UpstreamFunctionId", "DownstreamFunctionId", "SysEffectiveDate"],
          ["TID", "SOURCE_CLIENT_ID", "TID", "SOURCE_PROVIDER_ID", "10", "20", "2026/09/28"],
          ["TID", "SOURCE_CLIENT_ID", "TID", "SOURCE_PROVIDER_ID", "10", "110", "2026/09/28"],
        ],
      },
      {
        name: "LE_1214416713655.csv",
        rows: [
          ["SetCode", "OrganizationCode", "ReferenceGroupName", "Name", "SysEffectiveDate"],
          ["US1", "SOURCE_INTERNAL_ID", "AR_PAYMENT_TERMS", "TID", "2026/09/28"],
          ["US1", "SOURCE_INTERNAL_ID", "AR_REMIT_TO_ADDRESS", "TID", "2026/09/28"],
        ],
      },
    ],
  });

  assert.deepEqual(normalized.records.map((record) => [record.dataset, record.recordKey]), [
    ["FUN_BUSINESS_UNIT", "TID"],
    ["FUN_BU_USAGE", "TID | 10"],
    ["FUN_BU_USAGE", "TID | 20"],
    ["FUN_BU_SERVICE_PROVIDERS", "TID | TID | 10 | 20"],
    ["FUN_BU_SERVICE_PROVIDERS", "TID | TID | 10 | 110"],
    ["LE_1214416713655", "TID | AR_PAYMENT_TERMS"],
    ["LE_1214416713655", "TID | AR_REMIT_TO_ADDRESS"],
  ]);
  assert.equal(normalized.records.some((record) => Object.keys(record.fields).some((field) => /OrganizationCode|SysEffectiveDate/.test(field))), false);
});

test("Inventory Locator Key Flexfield segments use their parent structure and segment as a unique key", () => {
  const normalized = normalizeTaskResult({
    name: "Manage Inventory Locator Key Flexfield",
    code: "INV_MANAGE_INVENTORY_LOCATOR_KEY_FLEXFIELD",
    files: [{
      name: "ORA_FND_APP_KEY_FLEXFIELD_STRUCTURE_INSTANCE_SEGMENT.csv",
      rows: [
        [
          "FND_APP_KEY_FLEXFIELD.KeyFlexfieldCode",
          "FND_APP_KEY_FLEXFIELD.ApplicationId",
          "ORA_FND_APP_KEY_FLEXFIELD_STRUCTURE_INSTANCE.StructureInstanceCode",
          "SegmentCode",
          "ValueSetCode",
        ],
        ["MTLL", "401", "PREDEF_STOCK_LOCATOR_STRUCT_IN", "Aisle", "ORA_Inventory Locator VS 10"],
        ["MTLL", "401", "PREDEF_STOCK_LOCATOR_STRUCT_IN", "Bin", "ORA_Inventory Locator VS 10"],
        ["MTLL", "401", "PREDEF_STOCK_LOCATOR_STRUCT_IN", "Rack", "ORA_Inventory Locator VS 10"],
        ["MTLL", "401", "PREDEF_STOCK_LOCATOR_STRUCT_IN", "Row", "ORA_Inventory Locator VS 10"],
      ],
    }],
  });

  assert.deepEqual(normalized.records.map((record) => record.recordKey), [
    "MTLL | 401 | PREDEF_STOCK_LOCATOR_STRUCT_IN | Aisle",
    "MTLL | 401 | PREDEF_STOCK_LOCATOR_STRUCT_IN | Bin",
    "MTLL | 401 | PREDEF_STOCK_LOCATOR_STRUCT_IN | Rack",
    "MTLL | 401 | PREDEF_STOCK_LOCATOR_STRUCT_IN | Row",
  ]);
  assert.equal(new Set(normalized.records.map((record) => record.recordKey)).size, 4);
});
