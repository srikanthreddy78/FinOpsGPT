// src/routes/resources.js
const express = require('express');
const router = express.Router();
const { getResources, getResourceById } = require('../data/loader');
const { analyzeResource, analyzeAll } = require('../rules/engine');

// GET /api/resources — list all resources with analysis
router.get('/', (req, res) => {
  const { type, environment, team, status } = req.query;

  let resources = getResources({ type, environment, team });
  let results = resources.map((r) => {
    const analysis = analyzeResource(r);
    return { ...r, analysis };
  });

  // Filter by status if requested
  if (status) {
    results = results.filter((r) => r.analysis.status === status);
  }

  // Sort: critical first, then by savings
  results.sort((a, b) => {
    const statusOrder = { critical: 0, warning: 1, info: 2, healthy: 3 };
    const sa = statusOrder[a.analysis.status] ?? 3;
    const sb = statusOrder[b.analysis.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return (b.analysis.estimated_savings || 0) - (a.analysis.estimated_savings || 0);
  });

  res.json({
    total: results.length,
    resources: results
  });
});

// GET /api/resources/:id — single resource deep analysis
router.get('/:id', (req, res) => {
  const resource = getResourceById(req.params.id);
  if (!resource) {
    return res.status(404).json({ error: `Resource ${req.params.id} not found` });
  }

  const analysis = analyzeResource(resource);
  res.json({ resource, analysis });
});

module.exports = router;
