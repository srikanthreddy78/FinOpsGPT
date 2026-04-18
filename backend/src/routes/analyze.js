// src/routes/analyze.js
const express = require('express');
const router = express.Router();
const { getResources, getResourceById } = require('../data/loader');
const { analyzeAll } = require('../rules/engine');
const { computeKPIs } = require('../kpi/calculator');
const { analyzeWithClaude, analyzeMultipleWithClaude, chatWithAgent } = require('../agent/claude');

// POST /api/analyze — run OpenAI analysis on all or specific resources
router.post('/', async (req, res) => {
  try {
    const { resource_id, resource_ids } = req.body;

    if (resource_id) {
      // Single resource
      const resource = getResourceById(resource_id);
      if (!resource) {
        return res.status(404).json({ error: `Resource ${resource_id} not found` });
      }
      const result = await analyzeWithClaude(resource);
      return res.json({ analysis: result });
    }

    if (resource_ids && Array.isArray(resource_ids)) {
      // Specific resources
      const resources = resource_ids
        .map((id) => getResourceById(id))
        .filter(Boolean);
      const result = await analyzeMultipleWithClaude(resources);
      return res.json({ analysis: result });
    }

    // All resources
    const resources = getResources();
    const result = await analyzeMultipleWithClaude(resources);
    return res.json({ analysis: result });
  } catch (error) {
    console.error('[Analyze] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/analyze/chat — chat with the AI agent
router.post('/chat', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Build context from current analysis
    const resources = getResources();
    const analysis = analyzeAll(resources);
    const kpis = computeKPIs(resources, analysis);

    const context = {
      summary: kpis.summary,
      quick_wins: kpis.quick_wins,
      critical_alerts: kpis.critical_alerts,
      recommendations: analysis.filter((a) => a.primary_action !== 'NO_ACTION').map((a) => ({
        resource_id: a.resource_id,
        name: a.name,
        type: a.resource_type,
        action: a.primary_action,
        savings: a.estimated_savings,
        reason: a.action_details
      }))
    };

    const response = await chatWithAgent(question, context);
    res.json({ question, response });
  } catch (error) {
    console.error('[Chat] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/recommendations — rule-engine recommendations sorted by savings
router.get('/recommendations', (req, res) => {
  const resources = getResources();
  const analysis = analyzeAll(resources);

  const recommendations = analysis
    .filter((a) => a.primary_action !== 'NO_ACTION')
    .sort((a, b) => (b.estimated_savings || 0) - (a.estimated_savings || 0));

  const totalSavings = recommendations.reduce((s, a) => s + Math.max(a.estimated_savings, 0), 0);

  res.json({
    total_recommendations: recommendations.length,
    total_monthly_savings: Math.round(totalSavings * 100) / 100,
    recommendations
  });
});

module.exports = router;
