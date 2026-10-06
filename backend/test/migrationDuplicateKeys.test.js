const test = require("node:test");
const assert = require("node:assert/strict");
const { duplicateKeyBlockingErrors } = require("../src/migrationService");

test("migration blocks ambiguous duplicate comparison keys", () => {
  const blockers = duplicateKeyBlockingErrors([
    {
      code: "DUPLICATE_COMPARISON_KEY",
      key: "FUN_MANAGE_BUSINESS_UNIT::FUN_BU_USAGE::TID",
      message: "SOURCE contains 14 records for comparison key FUN_MANAGE_BUSINESS_UNIT::FUN_BU_USAGE::TID.",
    },
    { code: "SOME_OTHER_WARNING", message: "Not blocking here." },
  ]);

  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].configurationItem, "FUN_MANAGE_BUSINESS_UNIT");
  assert.equal(blockers[0].dataset, "FUN_BU_USAGE");
  assert.equal(blockers[0].recordKey, "TID");
  assert.match(blockers[0].message, /Migration is blocked/);
});
