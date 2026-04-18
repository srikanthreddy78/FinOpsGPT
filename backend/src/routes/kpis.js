// src/routes/kpis.js
const express = require('express');
const router = express.Router();
const { getResources } = require('../data/loader');
const { analyzeAll } = require('../rules/engine');
const { computeKPIs } = require('../kpi/calculator');

// GET /api/kpis — full dashboard KPIs
router.get('/', (req, res) => {
  const resources = getResources();
  const analysis = analyzeAll(resources);
  const kpis = computeKPIs(resources, analysis);

  res.json(kpis);
});

module.exports = router;
