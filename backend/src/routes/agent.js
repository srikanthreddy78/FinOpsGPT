// src/routes/agent.js
// THE AI AGENT — OpenAI analyzes resources, decides actions, and executes them
// This replaces the rule engine with actual AI reasoning

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { getResources, getResourceById, getSystemPrompt, getPricing, getDecisionRules } = require('../data/loader');
const { createApproval, logAutoExecution } = require('../approvals/store');
const ec2Actions = require('../actions/ec2');
const ebsActions = require('../actions/ebs');
const rdsActions = require('../actions/rds');

function getClient() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_key_here') {
    throw new Error('OPENAI_API_KEY not set. Add your key to .env file.');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Helper: call OpenAI and return the text content
async function callOpenAI(client, { model = 'gpt-4o', max_tokens = 4096, system, userContent }) {
  const response = await client.chat.completions.create({
    model,
    max_tokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent }
    ]
  });
  return response.choices[0]?.message?.content || '';
}

// ============================================================
// POST /api/agent/scan — Full AI Agent Pipeline
// OpenAI scans ALL resources → decides actions → auto-kills zombies → queues the rest
// ============================================================
router.post('/scan', async (req, res) => {
  try {
    const client = getClient();
    const resources = getResources();
    const pricing = getPricing();
    const rules = getDecisionRules();

    console.log('\n[AI AGENT] Starting full infrastructure scan...');
    console.log(`[AI AGENT] Analyzing ${resources.length} resources with OpenAI...\n`);

    // Build resource summaries for OpenAI
    const resourceData = resources.map((r) => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type,
      name: r.name,
      instance_type: r.instance_type || null,
      environment: r.environment,
      team: r.team,
      monthly_cost: r.monthly_cost_usd,
      cpu_avg: r.cpu_avg_pct,
      cpu_peak: r.cpu_peak_pct,
      memory_avg: r.memory_avg_pct,
      memory_peak: r.memory_peak_pct,
      disk_used_pct: r.disk_used_pct,
      uptime_days: r.uptime_days,
      last_deploy: r.last_deploy_date,
      last_active: r.last_active_date,
      volume_type: r.volume_type,
      attached: r.attached,
      multi_az: r.multi_az,
      storage_gb: r.storage_gb,
      iops_provisioned: r.iops_provisioned,
      iops_used_avg: r.iops_used_avg,
      connections_avg: r.connections_avg,
      connections_max: r.connections_max
    }));

    const systemPrompt = `You are CloudPulse, an AI FinOps agent. You analyze AWS infrastructure and make REAL decisions about what to terminate, downscale, migrate, or upscale.

YOUR PERMISSION MODEL:
- TERMINATE (zombie/idle EC2): AUTO — no permission needed
- DELETE (unattached EBS): AUTO — no permission needed  
- DOWNSCALE: APPROVAL_REQUIRED — needs human approval
- UPSCALE: APPROVAL_REQUIRED — needs human approval
- MIGRATE (gp2→gp3, io1→gp3): APPROVAL_REQUIRED
- SCHEDULE (start/stop dev boxes): APPROVAL_REQUIRED
- CONVERT_TO_SPOT: APPROVAL_REQUIRED
- DISABLE_MULTI_AZ: APPROVAL_REQUIRED
- NO_ACTION: for healthy resources

You MUST respond with ONLY a valid JSON object, no markdown, no backticks, no explanation outside the JSON.`;

    const userPrompt = `Analyze these ${resources.length} AWS resources and decide what action to take on EACH one.

RESOURCES:
${JSON.stringify(resourceData, null, 2)}

DECISION RULES (use as guidance, but apply your own reasoning too):
${JSON.stringify(rules, null, 2)}

PRICING REFERENCE:
${JSON.stringify(pricing, null, 2)}

TODAY'S DATE: ${new Date().toISOString().split('T')[0]}

For EACH resource, decide an action. Respond with this exact JSON structure:
{
  "scan_summary": {
    "total_resources": 42,
    "total_monthly_spend": 7172.23,
    "total_identified_savings": 0,
    "waste_percentage": 0,
    "zombies_found": 0,
    "critical_upscale_needed": 0
  },
  "decisions": [
    {
      "resource_id": "i-xxx",
      "resource_type": "EC2",
      "name": "server-name",
      "action": "TERMINATE|DELETE|DOWNSCALE|UPSCALE|MIGRATE|SCHEDULE|CONVERT_TO_SPOT|DISABLE_MULTI_AZ|NO_ACTION",
      "permission": "AUTO|APPROVAL_REQUIRED|NONE",
      "priority": "P0|P1|P2|NONE",
      "status": "critical|warning|info|healthy",
      "target": "target instance type or null",
      "estimated_savings": 123.45,
      "reasoning": "Why this action — use actual metric values",
      "risk_level": "low|medium|high",
      "implementation_steps": ["step1", "step2"]
    }
  ],
  "top_3_quick_wins": ["resource_id_1", "resource_id_2", "resource_id_3"],
  "urgent_alerts": [
    {
      "resource_id": "i-xxx",
      "name": "server-name",
      "reason": "why this is urgent"
    }
  ]
}`;

    // Call OpenAI
    console.log('[AI AGENT] Sending data to OpenAI for analysis...');
    const rawText = await callOpenAI(client, {
      model: 'gpt-4o',
      max_tokens: 8192,
      system: systemPrompt,
      userContent: userPrompt
    });

    // Parse OpenAI's response
    let aiDecisions;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      aiDecisions = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[AI AGENT] Failed to parse OpenAI response:', parseErr.message);
      return res.status(500).json({
        error: 'Failed to parse AI response',
        raw_response: rawText.slice(0, 2000)
      });
    }

    console.log(`[AI AGENT] OpenAI returned ${aiDecisions.decisions?.length || 0} decisions`);

    // ============================================================
    // EXECUTE: Auto-kill what AI says to kill, queue the rest
    // ============================================================
    const autoExecuted = [];
    const approvalQueued = [];
    const noAction = [];
    const urgentAlerts = [];

    for (const decision of (aiDecisions.decisions || [])) {
      const resource = getResourceById(decision.resource_id);
      if (!resource) continue;

      // AUTO EXECUTE — kill it now
      if (decision.permission === 'AUTO' && decision.action !== 'NO_ACTION') {
        let result;

        switch (decision.action) {
          case 'TERMINATE':
            console.log(`[AI AGENT] 💀 AUTO-KILLING: ${decision.name} (${decision.resource_id}) — ${decision.reasoning}`);
            result = await ec2Actions.terminateInstance(resource.resource_id, resource.name);
            break;

          case 'DELETE':
            console.log(`[AI AGENT] 🗑️  AUTO-DELETING: ${decision.name} (${decision.resource_id}) — ${decision.reasoning}`);
            result = await ebsActions.deleteVolume(resource.resource_id, resource.name);
            break;

          default:
            result = { action: decision.action, mode: 'skipped', message: `Auto-execute not supported for ${decision.action}` };
        }

        logAutoExecution(resource, decision.action, result);
        autoExecuted.push({
          ...decision,
          execution_result: result
        });
      }

      // APPROVAL REQUIRED — queue it
      else if (decision.permission === 'APPROVAL_REQUIRED') {
        const analysis = {
          primary_action: decision.action,
          target_instance: decision.target,
          estimated_savings: decision.estimated_savings,
          action_details: decision.reasoning,
          rules_triggered: [],
          resource_type: decision.resource_type
        };

        const approval = createApproval(analysis, resource);
        approvalQueued.push({
          ...decision,
          approval_id: approval.id,
          approval_status: 'pending'
        });
        console.log(`[AI AGENT] ⏳ QUEUED FOR APPROVAL: ${decision.name} → ${decision.action} (saves $${decision.estimated_savings}/mo)`);
      }

      // URGENT — needs upscale
      else if (decision.status === 'critical' && (decision.action === 'UPSCALE')) {
        urgentAlerts.push(decision);
        // Still queue for approval since upscale costs money
        const analysis = {
          primary_action: decision.action,
          target_instance: decision.target,
          estimated_savings: decision.estimated_savings || 0,
          action_details: decision.reasoning,
          rules_triggered: [],
          resource_type: decision.resource_type
        };
        const approval = createApproval(analysis, resource);
        approvalQueued.push({
          ...decision,
          approval_id: approval.id,
          approval_status: 'pending',
          urgent: true
        });
        console.log(`[AI AGENT] 🚨 URGENT ALERT: ${decision.name} — ${decision.reasoning}`);
      }

      // NO ACTION — healthy
      else {
        noAction.push(decision);
      }
    }

    const totalAutoSavings = autoExecuted.reduce((s, d) => s + (d.estimated_savings || 0), 0);
    const totalApprovalSavings = approvalQueued.reduce((s, d) => s + Math.max(d.estimated_savings || 0, 0), 0);

    console.log(`\n[AI AGENT] ✅ Scan complete!`);
    console.log(`[AI AGENT] Auto-killed: ${autoExecuted.length} resources → $${Math.round(totalAutoSavings)}/mo saved`);
    console.log(`[AI AGENT] Queued for approval: ${approvalQueued.length} resources → $${Math.round(totalApprovalSavings)}/mo potential savings`);
    console.log(`[AI AGENT] Healthy (no action): ${noAction.length} resources`);
    console.log(`[AI AGENT] Urgent alerts: ${urgentAlerts.length}\n`);

    res.json({
      agent: 'CloudPulse AI Agent',
      model: 'gpt-4o',
      mode: process.env.EXECUTE_MODE || 'dry_run',
      scan_summary: aiDecisions.scan_summary || {},
      results: {
        auto_executed: {
          count: autoExecuted.length,
          monthly_savings: Math.round(totalAutoSavings * 100) / 100,
          actions: autoExecuted
        },
        approval_queued: {
          count: approvalQueued.length,
          potential_savings: Math.round(totalApprovalSavings * 100) / 100,
          actions: approvalQueued
        },
        healthy: {
          count: noAction.length,
          resources: noAction
        },
        urgent_alerts: urgentAlerts
      },
      top_3_quick_wins: aiDecisions.top_3_quick_wins || []
    });

  } catch (error) {
    console.error('[AI AGENT] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// POST /api/agent/analyze/:id — AI analyzes a single resource
// ============================================================
router.post('/analyze/:id', async (req, res) => {
  try {
    const client = getClient();
    const resource = getResourceById(req.params.id);
    if (!resource) {
      return res.status(404).json({ error: `Resource ${req.params.id} not found` });
    }

    const pricing = getPricing();
    const rules = getDecisionRules();

    const text = await callOpenAI(client, {
      model: 'gpt-4o',
      max_tokens: 2048,
      system: `You are CloudPulse, an AI FinOps advisor. Analyze this AWS resource and recommend an action. Be specific — cite actual metric values. Respond with ONLY a JSON object, no markdown.`,
      userContent: `Analyze this resource:

${JSON.stringify(resource, null, 2)}

Pricing: ${JSON.stringify(pricing, null, 2)}
Rules: ${JSON.stringify(rules, null, 2)}
Today: ${new Date().toISOString().split('T')[0]}

Respond with:
{
  "resource_id": "${resource.resource_id}",
  "name": "${resource.name}",
  "status": "critical|warning|info|healthy",
  "action": "TERMINATE|DELETE|DOWNSCALE|UPSCALE|MIGRATE|SCHEDULE|NO_ACTION",
  "permission": "AUTO|APPROVAL_REQUIRED|NONE",
  "target": "target type or null",
  "estimated_savings": 0,
  "reasoning": "detailed explanation with actual numbers",
  "risk_level": "low|medium|high",
  "implementation_steps": ["step1", "step2", "step3"]
}`
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: text };

    res.json({ agent: 'OpenAI GPT-4o', resource_id: req.params.id, analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// POST /api/agent/chat — Talk to the AI agent
// ============================================================
router.post('/chat', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    const client = getClient();
    const resources = getResources();
    const pricing = getPricing();

    // Build full context for OpenAI
    const resourceSummary = resources.map((r) => ({
      id: r.resource_id,
      type: r.resource_type,
      name: r.name,
      env: r.environment,
      team: r.team,
      cost: r.monthly_cost_usd,
      cpu: r.cpu_avg_pct,
      memory: r.memory_avg_pct,
      instance: r.instance_type,
      attached: r.attached,
      multi_az: r.multi_az,
      volume_type: r.volume_type,
      uptime: r.uptime_days,
      last_active: r.last_active_date
    }));

    const answer = await callOpenAI(client, {
      model: 'gpt-4o',
      max_tokens: 2048,
      system: `You are CloudPulse, an AI FinOps agent managing AWS infrastructure. You have access to ${resources.length} resources with a total monthly spend of $7,172.23.

Here is the complete infrastructure data:
${JSON.stringify(resourceSummary, null, 2)}

Pricing reference:
${JSON.stringify(pricing, null, 2)}

Answer the user's question with specific resource IDs, names, dollar amounts, and actionable recommendations. Be direct and specific.`,
      userContent: question
    });

    res.json({ question, answer, model: 'gpt-4o' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// POST /api/agent/kill — AI decides what to kill and kills it NOW
// ============================================================
router.post('/kill', async (req, res) => {
  try {
    const client = getClient();
    const resources = getResources();

    console.log('[AI AGENT] 💀 Kill mode activated — asking OpenAI what to terminate...');

    const text = await callOpenAI(client, {
      model: 'gpt-4o',
      max_tokens: 4096,
      system: `You are CloudPulse kill agent. Identify resources that should be TERMINATED or DELETED immediately. Only include resources that are clearly waste — zombies, idle, unattached. Do NOT include production resources that are actively serving traffic. Respond with ONLY a JSON array, no markdown.`,
      userContent: `Which of these resources should be killed immediately?

${JSON.stringify(resources.map(r => ({
  id: r.resource_id, type: r.resource_type, name: r.name,
  env: r.environment, cost: r.monthly_cost_usd, cpu: r.cpu_avg_pct,
  attached: r.attached, uptime: r.uptime_days, last_active: r.last_active_date
})), null, 2)}

Today: ${new Date().toISOString().split('T')[0]}

Return JSON array:
[
  {
    "resource_id": "xxx",
    "resource_type": "EC2|EBS",
    "name": "name",
    "action": "TERMINATE|DELETE",
    "monthly_savings": 123,
    "reasoning": "why kill it"
  }
]`
    });

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const killList = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    console.log(`[AI AGENT] OpenAI identified ${killList.length} resources to kill`);

    // Execute kills
    const results = [];
    for (const target of killList) {
      const resource = getResourceById(target.resource_id);
      if (!resource) continue;

      let result;
      if (target.action === 'TERMINATE' && resource.resource_type === 'EC2') {
        console.log(`[AI AGENT] 💀 Killing ${target.name} — ${target.reasoning}`);
        result = await ec2Actions.terminateInstance(resource.resource_id, resource.name);
      } else if (target.action === 'DELETE' && resource.resource_type === 'EBS') {
        console.log(`[AI AGENT] 🗑️  Deleting ${target.name} — ${target.reasoning}`);
        result = await ebsActions.deleteVolume(resource.resource_id, resource.name);
      } else {
        result = { skipped: true, reason: `Cannot auto-execute ${target.action} on ${resource.resource_type}` };
      }

      logAutoExecution(resource, target.action, result);
      results.push({ ...target, execution: result });
    }

    const totalSaved = results.reduce((s, r) => s + (r.monthly_savings || 0), 0);

    res.json({
      agent: 'CloudPulse Kill Agent',
      model: 'gpt-4o',
      mode: process.env.EXECUTE_MODE || 'dry_run',
      killed: results.length,
      monthly_savings: Math.round(totalSaved * 100) / 100,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
