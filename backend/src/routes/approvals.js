// src/routes/approvals.js
const express = require('express');
const router = express.Router();
const { getAllApprovals, getApproval, approveAction, rejectAction, getStats } = require('../approvals/store');

// GET /api/approvals — list all approvals (filter by status)
router.get('/', (req, res) => {
  const { status } = req.query; // pending | approved | rejected | executed
  const approvals = getAllApprovals(status || null);

  res.json({
    total: approvals.length,
    filter: status || 'all',
    approvals
  });
});

// GET /api/approvals/stats — approval queue stats
router.get('/stats', (req, res) => {
  res.json(getStats());
});

// GET /api/approvals/pending — shortcut for pending approvals
router.get('/pending', (req, res) => {
  const pending = getAllApprovals('pending');
  const totalSavings = pending.reduce((s, a) => s + Math.max(a.estimated_savings, 0), 0);

  res.json({
    total_pending: pending.length,
    total_savings_waiting: Math.round(totalSavings * 100) / 100,
    approvals: pending
  });
});

// GET /api/approvals/:id — single approval detail
router.get('/:id', (req, res) => {
  const approval = getApproval(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  res.json(approval);
});

// POST /api/approvals/:id/approve — approve an action
router.post('/:id/approve', (req, res) => {
  const { approved_by } = req.body;
  const result = approveAction(req.params.id, approved_by || 'admin');

  if (!result) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    message: `Action approved for ${result.resource_id}. Now execute it via POST /api/actions/execute/${req.params.id}`,
    approval: result
  });
});

// POST /api/approvals/:id/reject — reject an action
router.post('/:id/reject', (req, res) => {
  const { rejected_by, reason } = req.body;
  const result = rejectAction(req.params.id, rejected_by || 'admin', reason || '');

  if (!result) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    message: `Action rejected for ${result.resource_id}`,
    approval: result
  });
});

module.exports = router;
