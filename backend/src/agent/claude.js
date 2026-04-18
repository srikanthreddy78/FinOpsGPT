// src/agent/claude.js
// OpenAI Agent — uses OpenAI API for intelligent resource analysis and recommendations

const OpenAI = require('openai');
const { getSystemPrompt, getPricing, getDecisionRules } = require('../data/loader');

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// Analyze a single resource with OpenAI
async function analyzeWithClaude(resource) {
  const systemPrompt = getSystemPrompt();
  const pricing = getPricing();
  const rules = getDecisionRules();

  const userPrompt = `Analyze this AWS resource and provide a recommendation:

Resource: ${resource.resource_id}
Type: ${resource.resource_type} | Instance: ${resource.instance_type || 'N/A'}
Name: ${resource.name}
Environment: ${resource.environment}
CPU: ${resource.cpu_avg_pct}% avg / ${resource.cpu_peak_pct}% peak
Memory: ${resource.memory_avg_pct}% avg / ${resource.memory_peak_pct}% peak
Disk Used: ${resource.disk_used_pct}%
Monthly Cost: $${resource.monthly_cost_usd}
Uptime: ${resource.uptime_days} days
Last Deploy: ${resource.last_deploy_date || 'N/A'}
Last Active: ${resource.last_active_date || 'N/A'}
Volume Type: ${resource.volume_type || 'N/A'}
Attached: ${resource.attached}
Multi-AZ: ${resource.multi_az}
IOPS Provisioned: ${resource.iops_provisioned} | Used Avg: ${resource.iops_used_avg}
Connections: ${resource.connections_avg} avg / ${resource.connections_max} max
Team: ${resource.team}

Decision Rules:
${JSON.stringify(rules, null, 2)}

Pricing Reference:
${JSON.stringify(pricing, null, 2)}

Respond with a JSON object:
{
  "resource_id": "${resource.resource_id}",
  "status": "critical|warning|healthy|info",
  "rules_triggered": ["R01", ...],
  "action": "TERMINATE|DOWNSCALE|UPSCALE|MIGRATE|SCHEDULE|CONVERT_TO_SPOT|DELETE|DISABLE_MULTI_AZ|NO_ACTION",
  "action_details": "explanation...",
  "recommended_change": "current → target",
  "estimated_monthly_savings": 123.45,
  "risk_level": "low|medium|high",
  "implementation_steps": ["step1", "step2", ...]
}`;

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const text = response.choices[0]?.message?.content || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { raw_response: text, error: 'Could not parse JSON from OpenAI response' };
  } catch (error) {
    console.error('[OpenAI Agent] API error:', error.message);
    return { error: error.message };
  }
}

// Analyze multiple resources with OpenAI
async function analyzeMultipleWithClaude(resources) {
  const systemPrompt = getSystemPrompt();
  const pricing = getPricing();
  const rules = getDecisionRules();

  const resourceSummaries = resources.map((r) => ({
    resource_id: r.resource_id,
    type: r.resource_type,
    name: r.name,
    instance: r.instance_type,
    environment: r.environment,
    cpu_avg: r.cpu_avg_pct,
    cpu_peak: r.cpu_peak_pct,
    memory_avg: r.memory_avg_pct,
    cost: r.monthly_cost_usd,
    uptime_days: r.uptime_days,
    last_active: r.last_active_date,
    volume_type: r.volume_type,
    attached: r.attached,
    multi_az: r.multi_az,
    iops_provisioned: r.iops_provisioned,
    iops_used: r.iops_used_avg,
    connections_avg: r.connections_avg,
    connections_max: r.connections_max,
    disk_used_pct: r.disk_used_pct
  }));

  const userPrompt = `Analyze ALL of these ${resources.length} AWS resources and provide recommendations for each.

Resources:
${JSON.stringify(resourceSummaries, null, 2)}

Decision Rules:
${JSON.stringify(rules, null, 2)}

Pricing Reference:
${JSON.stringify(pricing, null, 2)}

Respond with a JSON object:
{
  "recommendations": [
    {
      "resource_id": "xxx",
      "status": "critical|warning|healthy|info",
      "rules_triggered": ["R01"],
      "action": "TERMINATE|DOWNSCALE|UPSCALE|MIGRATE|DELETE|NO_ACTION|...",
      "action_details": "explanation",
      "recommended_change": "current → target",
      "estimated_monthly_savings": 123.45,
      "risk_level": "low|medium|high"
    }
  ],
  "total_monthly_savings": 2200,
  "top_3_quick_wins": ["resource_id_1", "resource_id_2", "resource_id_3"],
  "urgent_alerts": ["resource_id needing upscale"]
}`;

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const text = response.choices[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { raw_response: text, error: 'Could not parse JSON from OpenAI response' };
  } catch (error) {
    console.error('[OpenAI Agent] API error:', error.message);
    return { error: error.message };
  }
}

// Chat with the agent — ask natural language questions
async function chatWithAgent(question, context = {}) {
  const systemPrompt = getSystemPrompt() + `

You also have access to this analysis context:
${JSON.stringify(context, null, 2)}

Answer the user's question about their infrastructure. Be specific with resource names, costs, and recommendations.
If they ask "which servers should I kill" or similar, give a ranked list with savings.
Always include dollar amounts and specific resource IDs.`;

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ]
    });

    return response.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('[OpenAI Agent] Chat error:', error.message);
    return `Error communicating with AI agent: ${error.message}`;
  }
}

module.exports = { analyzeWithClaude, analyzeMultipleWithClaude, chatWithAgent };
