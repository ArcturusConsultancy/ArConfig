const express = require("express");
const { compare } = require("../controllers/comparisonController");
const { compareComplete } = require("../controllers/completeComparisonController");

const router = express.Router();
router.post("/run", compare);
router.post("/complete-setup", compareComplete);
module.exports = router;
