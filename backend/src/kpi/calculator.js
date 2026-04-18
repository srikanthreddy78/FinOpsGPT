// src/kpi/calculator.js
// Computes all dashboard KPIs from analysis results

function computeKPIs(resources, analysisResults) {
  const totalSpend = resources.reduce((sum, r) => sum + (r.monthly_cost_usd || 0), 0);

  // Savings breakdown
  const autoExecuteSavings = analysisResults
    .filter((a) => a.permission === 'AUTO_EXECUTE')
    .reduce((sum, a) => sum + Math.max(a.estimated_savings, 0), 0);

  const approvalSavings = analysisResults
    .filter((a) => a.permission === 'REQUIRES_APPROVAL')
    .reduce((sum, a) => sum + Math.max(a.estimated_savings, 0), 0);

  const totalSavings = autoExecuteSavings + approvalSavings;

  // Status counts
  const statusCounts = { critical: 0, warning: 0, info: 0, healthy: 0 };
  analysisResults.forEach((a) => { statusCounts[a.status] = (statusCounts[a.status] || 0) + 1; });

  // By resource type
  const byType = {};
  analysisResults.forEach((a) => {
    if (!byType[a.resource_type]) {
      byType[a.resource_type] = { count: 0, spend: 0, waste: 0, actions: 0 };
    }
    byType[a.resource_type].count++;
    byType[a.resource_type].spend += a.current_monthly_cost;
    if (a.estimated_savings > 0) {
      byType[a.resource_type].waste += a.estimated_savings;
      byType[a.resource_type].actions++;
    }
  });

  // By team
  const byTeam = {};
  resources.forEach((r, i) => {
    const analysis = analysisResults[i];
    const team = r.team || 'Unknown';
    if (!byTeam[team]) {
      byTeam[team] = { count: 0, spend: 0, waste: 0 };
    }
    byTeam[team].count++;
    byTeam[team].spend += r.monthly_cost_usd || 0;
    if (analysis && analysis.estimated_savings > 0) {
      byTeam[team].waste += analysis.estimated_savings;
    }
  });

  // By environment
  const byEnv = {};
  resources.forEach((r, i) => {
    const analysis = analysisResults[i];
    const env = r.environment || 'Unknown';
    if (!byEnv[env]) {
      byEnv[env] = { count: 0, spend: 0, waste: 0 };
    }
    byEnv[env].count++;
    byEnv[env].spend += r.monthly_cost_usd || 0;
    if (analysis && analysis.estimated_savings > 0) {
      byEnv[env].waste += analysis.estimated_savings;
    }
  });

  // Top 5 quick wins — highest savings, lowest risk
  const quickWins = analysisResults
    .filter((a) => a.estimated_savings > 0)
    .sort((a, b) => b.estimated_savings - a.estimated_savings)
    .slice(0, 5)
    .map((a) => ({
      resource_id: a.resource_id,
      name: a.name,
      action: a.primary_action,
      permission: a.permission,
      savings: Math.round(a.estimated_savings * 100) / 100
    }));

  // Critical alerts — things that need upscaling NOW
  const criticalAlerts = analysisResults
    .filter((a) => a.status === 'critical' && a.primary_action === 'UPSCALE')
    .map((a) => ({
      resource_id: a.resource_id,
      name: a.name,
      reason: a.action_details
    }));

  // Cost per useful CPU unit
  const cpuEfficiency = resources
    .filter((r) => r.resource_type === 'EC2' && r.cpu_avg_pct > 0)
    .map((r) => ({
      resource_id: r.resource_id,
      name: r.name,
      cost_per_cpu_unit: Math.round((r.monthly_cost_usd / r.cpu_avg_pct) * 100) / 100,
      cpu_avg: r.cpu_avg_pct,
      monthly_cost: r.monthly_cost_usd
    }))
    .sort((a, b) => b.cost_per_cpu_unit - a.cost_per_cpu_unit);

  return {
    summary: {
      total_resources: resources.length,
      total_monthly_spend: Math.round(totalSpend * 100) / 100,
      total_identified_savings: Math.round(totalSavings * 100) / 100,
      auto_execute_savings: Math.round(autoExecuteSavings * 100) / 100,
      approval_needed_savings: Math.round(approvalSavings * 100) / 100,
      waste_percentage: Math.round((totalSavings / totalSpend) * 10000) / 100,
      status_counts: statusCounts
    },
    by_type: byType,
    by_team: byTeam,
    by_environment: byEnv,
    quick_wins: quickWins,
    critical_alerts: criticalAlerts,
    cpu_efficiency: cpuEfficiency
  };
}

module.exports = { computeKPIs };
