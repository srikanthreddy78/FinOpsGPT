// src/rules/engine.js
// Evaluates 21 decision rules (R01-R21) against resources
// Returns triggered rules, recommended action, and estimated savings

const { getPricing, getDownsizeTarget, getUpscaleTarget, getPriceForInstance } = require('../data/loader');

const TODAY = new Date();

function daysSince(date) {
  if (!date) return 999;
  const d = date instanceof Date ? date : new Date(date);
  return Math.floor((TODAY - d) / (1000 * 60 * 60 * 24));
}

// ========== PERMISSION MODEL ==========
// AUTO_EXECUTE = no permission needed (terminate zombies, delete unattached)
// REQUIRES_APPROVAL = needs human approval (downscale, migrate, upscale, etc.)

const ACTION_PERMISSIONS = {
  TERMINATE: 'AUTO_EXECUTE',
  DELETE: 'AUTO_EXECUTE',
  DOWNSCALE: 'REQUIRES_APPROVAL',
  SCHEDULE: 'REQUIRES_APPROVAL',
  CONVERT_TO_SPOT: 'REQUIRES_APPROVAL',
  UPSCALE: 'REQUIRES_APPROVAL',
  SWITCH_FAMILY: 'REQUIRES_APPROVAL',
  MIGRATE: 'REQUIRES_APPROVAL',
  RESIZE: 'REQUIRES_APPROVAL',
  MOVE_STORAGE_CLASS: 'REQUIRES_APPROVAL',
  DISABLE_MULTI_AZ: 'REQUIRES_APPROVAL',
  REDUCE_STORAGE: 'REQUIRES_APPROVAL',
  BUY_RESERVED: 'REQUIRES_APPROVAL',
  NO_ACTION: 'NONE'
};

// ========== EC2 RULES ==========

function R01(r) {
  // Zombie: cpu < 5% AND last_active > 60 days ago
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct < 5 && daysSince(r.last_active_date) > 60) {
    return {
      rule_id: 'R01',
      priority: 'P0',
      action: 'TERMINATE',
      permission: ACTION_PERMISSIONS.TERMINATE,
      savings_pct: 100,
      estimated_savings: r.monthly_cost_usd,
      reason: `Zombie instance — ${r.cpu_avg_pct}% avg CPU, last active ${daysSince(r.last_active_date)} days ago`
    };
  }
  return null;
}

function R02(r) {
  // Idle: cpu < 10% AND uptime > 90 days
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct < 10 && r.uptime_days > 90) {
    return {
      rule_id: 'R02',
      priority: 'P0',
      action: 'TERMINATE',
      permission: ACTION_PERMISSIONS.TERMINATE,
      savings_pct: 100,
      estimated_savings: r.monthly_cost_usd,
      reason: `Idle instance — ${r.cpu_avg_pct}% avg CPU for ${r.uptime_days} days`
    };
  }
  return null;
}

function R03(r) {
  // Oversized: cpu 10-30% AND peak < 50%
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct >= 10 && r.cpu_avg_pct <= 30 && r.cpu_peak_pct < 50) {
    const pricing = getPricing();
    const target = getDownsizeTarget(r.instance_type, pricing);
    const targetCost = target ? getPriceForInstance(target, pricing) : r.monthly_cost_usd * 0.5;
    const savings = r.monthly_cost_usd - (targetCost || r.monthly_cost_usd * 0.5);
    return {
      rule_id: 'R03',
      priority: 'P1',
      action: 'DOWNSCALE',
      permission: ACTION_PERMISSIONS.DOWNSCALE,
      target_instance: target,
      savings_pct: Math.round((savings / r.monthly_cost_usd) * 100),
      estimated_savings: Math.round(savings * 100) / 100,
      reason: `Oversized — ${r.cpu_avg_pct}% avg CPU, ${r.cpu_peak_pct}% peak on ${r.instance_type}. Downscale to ${target || 'smaller type'}`
    };
  }
  return null;
}

function R04(r) {
  // Dev idle: cpu < 20% AND env = dev/staging
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct < 20 && ['development', 'staging', 'dev'].includes(r.environment)) {
    return {
      rule_id: 'R04',
      priority: 'P1',
      action: 'SCHEDULE',
      permission: ACTION_PERMISSIONS.SCHEDULE,
      savings_pct: 66,
      estimated_savings: Math.round(r.monthly_cost_usd * 0.66 * 100) / 100,
      reason: `Dev/staging idle — ${r.cpu_avg_pct}% CPU in ${r.environment}. Schedule start/stop for business hours only`
    };
  }
  return null;
}

function R05(r) {
  // Batch workload: cpu < 25% AND name contains batch/etl/job
  if (r.resource_type !== 'EC2') return null;
  const nameLC = (r.name || '').toLowerCase();
  if (r.cpu_avg_pct < 25 && (nameLC.includes('batch') || nameLC.includes('etl') || nameLC.includes('job'))) {
    return {
      rule_id: 'R05',
      priority: 'P2',
      action: 'CONVERT_TO_SPOT',
      permission: ACTION_PERMISSIONS.CONVERT_TO_SPOT,
      savings_pct: 65,
      estimated_savings: Math.round(r.monthly_cost_usd * 0.65 * 100) / 100,
      reason: `Batch workload "${r.name}" at ${r.cpu_avg_pct}% CPU — convert to Spot for ~65% savings`
    };
  }
  return null;
}

function R06(r) {
  // Over-utilized: cpu > 85% AND peak > 95%
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct > 85 && r.cpu_peak_pct > 95) {
    const pricing = getPricing();
    const target = getUpscaleTarget(r.instance_type, pricing);
    const targetCost = target ? getPriceForInstance(target, pricing) : r.monthly_cost_usd * 1.5;
    return {
      rule_id: 'R06',
      priority: 'P0',
      action: 'UPSCALE',
      permission: ACTION_PERMISSIONS.UPSCALE,
      target_instance: target,
      savings_pct: 0,
      estimated_savings: -(Math.round((targetCost - r.monthly_cost_usd) * 100) / 100),
      reason: `CRITICAL — ${r.cpu_avg_pct}% avg CPU, ${r.cpu_peak_pct}% peak. Upscale to ${target || 'larger type'} to prevent outage`
    };
  }
  return null;
}

function R07(r) {
  // Memory bottleneck: memory > 85% AND cpu < 50%
  if (r.resource_type !== 'EC2') return null;
  if (r.memory_avg_pct > 85 && r.cpu_avg_pct < 50) {
    return {
      rule_id: 'R07',
      priority: 'P1',
      action: 'SWITCH_FAMILY',
      permission: ACTION_PERMISSIONS.SWITCH_FAMILY,
      target_family: 'r5',
      savings_pct: 0,
      estimated_savings: 0,
      reason: `Memory bottleneck — ${r.memory_avg_pct}% memory, ${r.cpu_avg_pct}% CPU. Switch to r5 memory-optimized family`
    };
  }
  return null;
}

function R08(r) {
  // Right-sized: cpu 40-75% AND peak < 85%
  if (r.resource_type !== 'EC2') return null;
  if (r.cpu_avg_pct >= 40 && r.cpu_avg_pct <= 75 && r.cpu_peak_pct < 85) {
    return {
      rule_id: 'R08',
      priority: 'NONE',
      action: 'NO_ACTION',
      permission: 'NONE',
      savings_pct: 0,
      estimated_savings: 0,
      reason: `Healthy — ${r.cpu_avg_pct}% avg CPU, ${r.cpu_peak_pct}% peak. Right-sized.`
    };
  }
  return null;
}

// ========== EBS RULES ==========

function R09(r) {
  // Unattached volume
  if (r.resource_type !== 'EBS') return null;
  if (r.attached === false) {
    return {
      rule_id: 'R09',
      priority: 'P0',
      action: 'DELETE',
      permission: ACTION_PERMISSIONS.DELETE,
      savings_pct: 100,
      estimated_savings: r.monthly_cost_usd,
      reason: `Unattached EBS volume "${r.name}" — ${r.storage_gb}GB ${r.volume_type || 'unknown'} costing $${r.monthly_cost_usd}/mo with no instance`
    };
  }
  return null;
}

function R10(r) {
  // Legacy gp2
  if (r.resource_type !== 'EBS') return null;
  if (r.volume_type === 'gp2' && r.attached === true) {
    const savings = Math.round(r.monthly_cost_usd * 0.20 * 100) / 100;
    return {
      rule_id: 'R10',
      priority: 'P1',
      action: 'MIGRATE',
      permission: ACTION_PERMISSIONS.MIGRATE,
      target_type: 'gp3',
      savings_pct: 20,
      estimated_savings: savings,
      reason: `Legacy gp2 volume — migrate to gp3 for 20% savings ($${savings}/mo). Zero downtime.`
    };
  }
  return null;
}

function R11(r) {
  // io1 with low IOPS: switch to gp3
  if (r.resource_type !== 'EBS') return null;
  if (r.volume_type === 'io1' && r.iops_used_avg < 3000) {
    // gp3 gives 3000 IOPS free, so we save the entire io1 IOPS cost
    const gp3Cost = r.storage_gb * 0.08;
    const savings = Math.round((r.monthly_cost_usd - gp3Cost) * 100) / 100;
    return {
      rule_id: 'R11',
      priority: 'P0',
      action: 'MIGRATE',
      permission: ACTION_PERMISSIONS.MIGRATE,
      target_type: 'gp3',
      savings_pct: Math.round((savings / r.monthly_cost_usd) * 100),
      estimated_savings: savings,
      reason: `io1 with ${r.iops_used_avg} IOPS used (3000 provisioned) — gp3 gives 3000 free. Save $${savings}/mo`
    };
  }
  return null;
}

function R12(r) {
  // Oversized volume: disk_used < 25%
  if (r.resource_type !== 'EBS') return null;
  if (r.disk_used_pct < 25 && r.attached === true) {
    const newSize = Math.ceil((r.storage_gb * r.disk_used_pct / 100) * 1.3);
    const ratio = newSize / r.storage_gb;
    const savings = Math.round(r.monthly_cost_usd * (1 - ratio) * 100) / 100;
    return {
      rule_id: 'R12',
      priority: 'P1',
      action: 'RESIZE',
      permission: ACTION_PERMISSIONS.RESIZE,
      target_size_gb: newSize,
      savings_pct: Math.round((1 - ratio) * 100),
      estimated_savings: savings,
      reason: `Only ${r.disk_used_pct}% of ${r.storage_gb}GB used — resize to ${newSize}GB`
    };
  }
  return null;
}

function R13(r) {
  // Cold data on SSD: iops < 50 AND storage > 1TB
  if (r.resource_type !== 'EBS') return null;
  if (r.iops_used_avg <= 50 && r.storage_gb > 1000 && r.attached === true) {
    const sc1Cost = r.storage_gb * 0.015;
    const savings = Math.round((r.monthly_cost_usd - sc1Cost) * 100) / 100;
    return {
      rule_id: 'R13',
      priority: 'P2',
      action: 'MOVE_STORAGE_CLASS',
      permission: ACTION_PERMISSIONS.MOVE_STORAGE_CLASS,
      target_type: 'sc1',
      savings_pct: Math.round((savings / r.monthly_cost_usd) * 100),
      estimated_savings: savings,
      reason: `Cold data — ${r.iops_used_avg} IOPS on ${r.storage_gb}GB. Move to sc1 archive for $${savings}/mo savings`
    };
  }
  return null;
}

function R14(r) {
  // Right-sized EBS
  if (r.resource_type !== 'EBS') return null;
  if (r.attached === true && r.iops_provisioned > 0 &&
      r.iops_used_avg > r.iops_provisioned * 0.66 && r.disk_used_pct > 70) {
    return {
      rule_id: 'R14',
      priority: 'NONE',
      action: 'NO_ACTION',
      permission: 'NONE',
      savings_pct: 0,
      estimated_savings: 0,
      reason: `Healthy — IOPS utilization ${Math.round(r.iops_used_avg / r.iops_provisioned * 100)}%, disk ${r.disk_used_pct}% used`
    };
  }
  return null;
}

// ========== RDS RULES ==========

function R15(r) {
  // Non-prod Multi-AZ
  if (r.resource_type !== 'RDS') return null;
  if (r.multi_az === true && r.environment !== 'production') {
    const savings = Math.round(r.monthly_cost_usd * 0.50 * 100) / 100;
    return {
      rule_id: 'R15',
      priority: 'P0',
      action: 'DISABLE_MULTI_AZ',
      permission: ACTION_PERMISSIONS.DISABLE_MULTI_AZ,
      savings_pct: 50,
      estimated_savings: savings,
      reason: `Multi-AZ enabled on ${r.environment} database "${r.name}" — disable to save $${savings}/mo`
    };
  }
  return null;
}

function R16(r) {
  // Oversized DB: cpu < 20% AND connections < 20
  if (r.resource_type !== 'RDS') return null;
  if (r.cpu_avg_pct < 20 && r.connections_avg < 20) {
    const pricing = getPricing();
    const target = getDownsizeTarget(r.instance_type, pricing);
    const targetCost = target ? getPriceForInstance(target, pricing) : r.monthly_cost_usd * 0.5;
    const baseSavings = r.monthly_cost_usd - (targetCost || r.monthly_cost_usd * 0.5);
    // If multi-az, the actual savings are on the base cost (multi-az doubles it)
    const savings = Math.round(baseSavings * 100) / 100;
    return {
      rule_id: 'R16',
      priority: 'P1',
      action: 'DOWNSCALE',
      permission: ACTION_PERMISSIONS.DOWNSCALE,
      target_instance: target,
      savings_pct: Math.round((savings / r.monthly_cost_usd) * 100),
      estimated_savings: savings,
      reason: `Oversized DB — ${r.cpu_avg_pct}% CPU, ${r.connections_avg} connections on ${r.instance_type}. Downscale to ${target || 'smaller class'}`
    };
  }
  return null;
}

function R17(r) {
  // Over-utilized DB: cpu > 85% OR connections near max
  if (r.resource_type !== 'RDS') return null;
  if (r.cpu_avg_pct > 85 || (r.connections_max > 0 && r.connections_avg > r.connections_max * 0.8)) {
    const pricing = getPricing();
    const target = getUpscaleTarget(r.instance_type, pricing);
    return {
      rule_id: 'R17',
      priority: 'P0',
      action: 'UPSCALE',
      permission: ACTION_PERMISSIONS.UPSCALE,
      target_instance: target,
      savings_pct: 0,
      estimated_savings: 0,
      reason: `CRITICAL DB — ${r.cpu_avg_pct}% CPU, ${r.connections_avg}/${r.connections_max} connections. Upscale to ${target || 'larger class'} NOW`
    };
  }
  return null;
}

function R18(r) {
  // Legacy/expensive RDS storage
  if (r.resource_type !== 'RDS') return null;
  if (r.volume_type === 'gp2' || (r.volume_type === 'io1' && r.iops_used_avg < 3000)) {
    return {
      rule_id: 'R18',
      priority: 'P1',
      action: 'MIGRATE',
      permission: ACTION_PERMISSIONS.MIGRATE,
      target_type: 'gp3',
      savings_pct: 20,
      estimated_savings: Math.round(r.storage_gb * 0.02 * 100) / 100,
      reason: `RDS using ${r.volume_type} storage — migrate to gp3 for savings`
    };
  }
  return null;
}

function R19(r) {
  // RDS storage over-provisioned: disk_used < 10%
  if (r.resource_type !== 'RDS') return null;
  if (r.disk_used_pct < 10) {
    return {
      rule_id: 'R19',
      priority: 'P2',
      action: 'REDUCE_STORAGE',
      permission: ACTION_PERMISSIONS.REDUCE_STORAGE,
      savings_pct: 30,
      estimated_savings: Math.round(r.monthly_cost_usd * 0.1 * 100) / 100,
      reason: `RDS storage only ${r.disk_used_pct}% used (${r.storage_gb}GB allocated) — reduce allocation`
    };
  }
  return null;
}

function R20(r) {
  // Steady production workload — buy reserved
  if (r.resource_type !== 'RDS') return null;
  if (r.environment === 'production' && r.uptime_days > 365 &&
      r.cpu_avg_pct >= 30 && r.cpu_avg_pct <= 70) {
    return {
      rule_id: 'R20',
      priority: 'P2',
      action: 'BUY_RESERVED',
      permission: ACTION_PERMISSIONS.BUY_RESERVED,
      savings_pct: 37,
      estimated_savings: Math.round(r.monthly_cost_usd * 0.37 * 100) / 100,
      reason: `Steady production workload — ${r.cpu_avg_pct}% CPU for ${r.uptime_days} days. Buy 1yr reserved for 37% savings`
    };
  }
  return null;
}

function R21(r) {
  // Healthy RDS
  if (r.resource_type !== 'RDS') return null;
  if (r.cpu_avg_pct >= 40 && r.cpu_avg_pct <= 75 &&
      r.connections_max > 0 && r.connections_avg < r.connections_max * 0.7) {
    return {
      rule_id: 'R21',
      priority: 'NONE',
      action: 'NO_ACTION',
      permission: 'NONE',
      savings_pct: 0,
      estimated_savings: 0,
      reason: `Healthy DB — ${r.cpu_avg_pct}% CPU, ${r.connections_avg}/${r.connections_max} connections. Well-sized.`
    };
  }
  return null;
}

// ========== ENGINE ==========

const ALL_RULES = [R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21];

const PRIORITY_ORDER = { 'P0': 0, 'P1': 1, 'P2': 2, 'NONE': 3 };

function analyzeResource(resource) {
  const triggered = [];

  for (const ruleFn of ALL_RULES) {
    const result = ruleFn(resource);
    if (result) {
      triggered.push(result);
    }
  }

  // Sort by priority — P0 first
  triggered.sort((a, b) => (PRIORITY_ORDER[a.priority] || 3) - (PRIORITY_ORDER[b.priority] || 3));

  // Primary action = highest priority rule
  const primaryAction = triggered.find((t) => t.action !== 'NO_ACTION') || triggered[0] || null;

  // Determine status
  let status = 'healthy';
  if (primaryAction) {
    if (primaryAction.priority === 'P0' && primaryAction.action !== 'NO_ACTION') {
      status = 'critical';
    } else if (primaryAction.priority === 'P1') {
      status = 'warning';
    } else if (primaryAction.priority === 'P2') {
      status = 'info';
    }
  }

  return {
    resource_id: resource.resource_id,
    resource_type: resource.resource_type,
    name: resource.name,
    environment: resource.environment,
    current_monthly_cost: resource.monthly_cost_usd,
    status,
    rules_triggered: triggered.map((t) => t.rule_id),
    primary_action: primaryAction ? primaryAction.action : 'NO_ACTION',
    permission: primaryAction ? primaryAction.permission : 'NONE',
    action_details: primaryAction ? primaryAction.reason : 'No issues detected',
    target_instance: primaryAction ? primaryAction.target_instance : null,
    estimated_savings: primaryAction ? primaryAction.estimated_savings : 0,
    all_findings: triggered
  };
}

function analyzeAll(resources) {
  return resources.map(analyzeResource);
}

module.exports = {
  analyzeResource,
  analyzeAll,
  ACTION_PERMISSIONS
};
