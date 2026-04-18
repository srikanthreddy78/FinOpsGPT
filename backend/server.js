// server.js — CloudPulse FinOps Agent Backend
// AI-powered agent that analyzes AWS infrastructure, kills waste, and optimizes costs

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { loadDataset } = require('./src/data/loader');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Load dataset on startup
console.log('\n=========================================');
console.log('  CloudPulse FinOps Agent — Starting...');
console.log('=========================================\n');

try {
  loadDataset();
  console.log('[OK] Dataset loaded successfully\n');
} catch (error) {
  console.error('[FATAL] Failed to load dataset:', error.message);
  process.exit(1);
}

// Log execution mode
const mode = process.env.EXECUTE_MODE || 'dry_run';
console.log(`[CONFIG] Execution Mode: ${mode.toUpperCase()}`);
if (mode === 'live') {
  console.log('[WARNING] ⚠️  LIVE MODE — AWS actions will be EXECUTED for real!');
} else {
  console.log('[SAFE] 🛡️  DRY_RUN MODE — actions will be simulated only');
}
console.log('');

// Routes
const resourcesRouter = require('./src/routes/resources');
const kpisRouter = require('./src/routes/kpis');
const analyzeRouter = require('./src/routes/analyze');
const actionsRouter = require('./src/routes/actions');
const approvalsRouter = require('./src/routes/approvals');
const agentRouter = require('./src/routes/agent');

app.use('/api/resources', resourcesRouter);
app.use('/api/kpis', kpisRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/recommendations', analyzeRouter);
app.use('/api/actions', actionsRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/agent', agentRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CloudPulse FinOps Agent',
    execution_mode: mode,
    timestamp: new Date().toISOString()
  });
});

// API overview
app.get('/api', (req, res) => {
  res.json({
    service: 'CloudPulse FinOps Agent',
    version: '1.0.0',
    execution_mode: mode,
    endpoints: {
      'GET  /api/health': 'Health check',
      'GET  /api/resources': 'List all resources with analysis (query: ?type=EC2&environment=production&status=critical)',
      'GET  /api/resources/:id': 'Single resource deep analysis',
      'GET  /api/kpis': 'Dashboard KPIs — spend, waste, savings, risk',
      'GET  /api/recommendations': 'All recommendations sorted by savings',
      'POST /api/analyze': 'Run Claude AI analysis (body: { resource_id } or { resource_ids: [...] })',
      'POST /api/analyze/chat': 'Chat with AI agent (body: { question: "which servers should I kill?" })',
      'POST /api/actions/auto-execute': 'Kill zombies + delete unattached EBS (NO permission needed)',
      'POST /api/actions/request': 'Create approval requests for downgrades/migrations (body: { resource_id } or empty for all)',
      'POST /api/actions/execute/:id': 'Execute an APPROVED action on real AWS',
      'GET  /api/actions/log': 'Execution history',
      'GET  /api/approvals': 'List approvals (query: ?status=pending)',
      'GET  /api/approvals/pending': 'All pending approvals with total savings',
      'GET  /api/approvals/stats': 'Approval queue stats',
      'POST /api/approvals/:id/approve': 'Approve an action (body: { approved_by })',
      'POST /api/approvals/:id/reject': 'Reject an action (body: { rejected_by, reason })',
      '--- AI AGENT (needs ANTHROPIC_API_KEY) ---': '---',
      'POST /api/agent/scan': '🤖 FULL AI SCAN — Claude analyzes all resources, auto-kills zombies, queues rest for approval',
      'POST /api/agent/kill': '💀 AI KILL MODE — Claude decides what to kill and kills it immediately',
      'POST /api/agent/analyze/:id': '🔍 AI analyzes a single resource in depth',
      'POST /api/agent/chat': '💬 Chat with AI agent (body: { question: "..." })'
    },
    permission_model: {
      auto_execute: 'TERMINATE zombie EC2 + DELETE unattached EBS → no permission needed',
      requires_approval: 'DOWNSCALE, UPSCALE, MIGRATE, SCHEDULE, DISABLE_MULTI_AZ → needs human approval'
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found`, docs: 'GET /api for endpoint list' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message });
});

// Start
app.listen(PORT, () => {
  console.log(`\n🚀 CloudPulse FinOps Agent running on http://localhost:${PORT}`);
  console.log(`📋 API docs: http://localhost:${PORT}/api`);
  console.log(`📊 KPIs: http://localhost:${PORT}/api/kpis`);
  console.log(`🔍 Resources: http://localhost:${PORT}/api/resources`);
  console.log(`💀 Auto-kill (rules): POST http://localhost:${PORT}/api/actions/auto-execute`);
  console.log(`🤖 AI Agent Scan: POST http://localhost:${PORT}/api/agent/scan`);
  console.log(`🧠 AI Kill Mode: POST http://localhost:${PORT}/api/agent/kill`);
  console.log(`💬 AI Chat: POST http://localhost:${PORT}/api/agent/chat`);
  console.log('');
});
