/**
 * src/routes/extraction.js
 *
 * POST /api/extraction/run      -> triggers a full extraction run
 * GET  /api/extraction/history  -> returns past run history
 */

const express = require("express");
const router = express.Router();
const {
  runExtraction,
  cancelExtraction,
  getHistory,
  getExtractionProgress,
} = require("../controllers/extractionController");
const { runCompleteSetupExtraction } = require("../controllers/completeSetupController");

router.post("/run", runExtraction);
router.post("/complete-setup", runCompleteSetupExtraction);
router.post("/cancel/:progressId", cancelExtraction);
router.get("/history", getHistory);
router.get("/progress/:progressId", getExtractionProgress);

module.exports = router;
