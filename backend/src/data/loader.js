// src/data/loader.js
// Reads dataset.json, normalizes fields, provides clean data to the rest of the app

const fs = require('fs');
const path = require('path');

let _data = null;

function loadDataset() {
  if (_data) return _data;

  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../data/dataset.json'), 'utf-8')
  );

  // Normalize resources
  const resources = raw.resources.map((r) => {
    // Normalize em-dash to null
    Object.keys(r).forEach((k) => {
      if (r[k] === '—' || r[k] === '\u2014') r[k] = null;
    });

    // Parse booleans
    ['multi_az', 'attached'].forEach((field) => {
      if (typeof r[field] === 'string') {
        r[field] = r[field].toUpperCase() === 'TRUE';
      }
    });

    // Parse dates
    ['last_deploy_date', 'last_active_date'].forEach((field) => {
      if (r[field] && r[field] !== null) {
        r[field] = new Date(r[field]);
      }
    });

    // Ensure numeric fields
    [
      'vcpus', 'memory_gb', 'storage_gb', 'hourly_cost_usd', 'monthly_cost_usd',
      'cpu_avg_pct', 'cpu_peak_pct', 'memory_avg_pct', 'memory_peak_pct',
      'disk_used_pct', 'network_in_gbps', 'network_out_gbps',
      'iops_provisioned', 'iops_used_avg', 'connections_avg', 'connections_max',
      'uptime_days'
    ].forEach((field) => {
      if (r[field] !== null && r[field] !== undefined) {
        r[field] = Number(r[field]);
      }
    });

    return r;
  });

  _data = {
    resources,
    decisionRules: raw.decision_rules,
    pricing: raw.pricing,
    systemPrompt: raw.system_prompt
  };

  console.log(`[DataLoader] Loaded ${resources.length} resources, ${raw.decision_rules.length} rules`);
  return _data;
}

function getResources(filter = {}) {
  const { resources } = loadDataset();
  let result = [...resources];

  if (filter.type) {
    result = result.filter((r) => r.resource_type === filter.type);
  }
  if (filter.environment) {
    result = result.filter((r) => r.environment === filter.environment);
  }
  if (filter.team) {
    result = result.filter((r) => r.team === filter.team);
  }

  return result;
}

function getResourceById(id) {
  const { resources } = loadDataset();
  return resources.find((r) => r.resource_id === id) || null;
}

function getPricing() {
  return loadDataset().pricing;
}

function getDecisionRules() {
  return loadDataset().decisionRules;
}

function getSystemPrompt() {
  return loadDataset().systemPrompt;
}

// Get the next-smaller instance type for downsizing
function getDownsizeTarget(instanceType, pricing) {
  const families = {
    ec2: pricing.ec2,
    rds: pricing.rds
  };

  for (const [, list] of Object.entries(families)) {
    const idx = list.findIndex(
      (p) => p['Instance Type'] === instanceType || p['Instance Class'] === instanceType
    );
    if (idx > 0) {
      return list[idx - 1]['Instance Type'] || list[idx - 1]['Instance Class'];
    }
  }
  return null;
}

// Get the next-larger instance type for upscaling
function getUpscaleTarget(instanceType, pricing) {
  const families = {
    ec2: pricing.ec2,
    rds: pricing.rds
  };

  for (const [, list] of Object.entries(families)) {
    const idx = list.findIndex(
      (p) => p['Instance Type'] === instanceType || p['Instance Class'] === instanceType
    );
    if (idx >= 0 && idx < list.length - 1) {
      return list[idx + 1]['Instance Type'] || list[idx + 1]['Instance Class'];
    }
  }
  return null;
}

function getPriceForInstance(instanceType, pricing) {
  for (const p of [...pricing.ec2, ...pricing.rds]) {
    if (p['Instance Type'] === instanceType || p['Instance Class'] === instanceType) {
      return Number(p['Monthly ($)']);
    }
  }
  return null;
}

module.exports = {
  loadDataset,
  getResources,
  getResourceById,
  getPricing,
  getDecisionRules,
  getSystemPrompt,
  getDownsizeTarget,
  getUpscaleTarget,
  getPriceForInstance
};
