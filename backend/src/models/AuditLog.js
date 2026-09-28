const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema({
  ownerId: { type: String, index: true, default: "" },
  action: { type: String, required: true, index: true },
  status: { type: String, enum: ["SUCCESS", "FAILED", "CANCELLED"], default: "SUCCESS" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model("AuditLog", AuditLogSchema);
