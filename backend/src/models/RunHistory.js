/**
 * src/models/RunHistory.js
 *
 * Stores a record of every extraction run — this is the "M" (MongoDB)
 * part of the stack. Lets the React frontend show a history table
 * instead of only ever seeing the most recent run.
 */

const mongoose = require("mongoose");

const RunHistorySchema = new mongoose.Schema({
  ownerId: { type: String, default: "", index: true, select: false },
  operation: { type: String, enum: ["EXTRACT", "COMPARE", "MIGRATION"], default: "EXTRACT", index: true },
  lifecycleStatus: {
    type: String,
    enum: ["PENDING", "VALIDATING", "READY", "RUNNING", "VERIFYING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "BLOCKED"],
    default: "COMPLETED",
  },
  requestedBy: { type: String, default: "" },
  sourceConnection: { id: { type: String, default: "" }, name: { type: String, default: "" }, environmentType: { type: String, default: "" } },
  targetConnection: { id: { type: String, default: "" }, name: { type: String, default: "" }, environmentType: { type: String, default: "" } },
  configurationItems: { type: [String], default: [] },
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  resultSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  warnings: { type: [mongoose.Schema.Types.Mixed], default: [] },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: 0 },
  orgCodes: { type: [String], default: [] },
  offeringCode: { type: String, default: "" },
  offeringName: { type: String, default: "" },
  functionalAreaCode: { type: String, default: "" },
  functionalAreaName: { type: String, default: "" },
  taskMode: { type: String, enum: ["required", "all", "selected", "legacy"], default: "legacy" },
  taskCount: { type: Number, default: 0 },
  recordCount: { type: Number, default: 0 },
  taskResults: {
    type: [{
      code: { type: String, default: "" },
      name: { type: String, default: "" },
      status: { type: String, enum: ["success", "failed"], required: true },
      recordCount: { type: Number, default: 0 },
      errorMessage: { type: String, default: "" },
    }],
    default: [],
  },
  subinventoryCount: { type: Number, default: 0 },
  locatorCount: { type: Number, default: 0 },
  outputFile: { type: String, default: "" },
  status: { type: String, enum: ["success", "partial", "failed", "cancelled"], required: true },
  errorMessage: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, {
  toJSON: {
    transform: (_doc, value) => {
      delete value.ownerId;
      return value;
    },
  },
});

module.exports = mongoose.model("RunHistory", RunHistorySchema);
