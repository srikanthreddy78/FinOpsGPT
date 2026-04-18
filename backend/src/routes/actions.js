// src/routes/actions.js
// THE CORE: executes AWS actions based on permission model
// - AUTO_EXECUTE: kills zombies, deletes unattached EBS (no permission)
// - REQUIRES_APPROVAL: downscale, migrate, upscale (needs human approval first)

const express = require('express');
const router = express.Router();
const { getResources, getResourceById } = require('../data/loader');
const { analyzeResource, analyzeAll } = require('../rules/engine');
const { createApproval, getApproval, markExecuted, logAutoExecution, getExecutionLog } = require('../approvals/store');
const ec2Actions = require('../actions/ec2');
const ebsActions = require('../actions/ebs');
const rdsActions = require('../actions/rds');

// ======= POST /api/actions/auto-execute =======
// Runs all auto-executable actions: TERMINATE zombies + DELETE unattached EBS
// No permission needed — these are clearly waste
router.post('/auto-execute', async (req, res) => {
  try {
    const resources = getResources();
    const analysis = analyzeAll(resources);
    const results = [];

    for (let i = 0; i < analysis.length; i++) {
      const a = analysis[i];
      const r = resources[i];

      if (a.permission !== 'AUTO_EXECUTE') continue;

      let result;

      switch (a.primary_action) {
        case 'TERMINATE':
          // Kill zombie EC2 instances
          result = await ec2Actions.terminateInstance(r.resource_id, r.name);
          break;

        case 'DELETE':
          // Delete unattached EBS volumes
          result = await ebsActions.deleteVolume(r.resource_id, r.name);
          break;

        default:
          continue;
      }

      logAutoExecution(r, a.primary_action, result);
      results.push({
        resource_id: r.resource_id,
        name: r.name,
        type: r.resource_type,
        action: a.primary_action,
        savings: a.estimated_savings,
        result
      });
    }

    const totalSavings = results.reduce((s, r) => s + (r.savings || 0), 0);

    res.json({
      mode: process.env.EXECUTE_MODE || 'dry_run',
      actions_taken: results.length,
      total_monthly_savings: Math.round(totalSavings * 100) / 100,
      results
    });
  } catch (error) {
    console.error('[AutoExecute] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======= POST /api/actions/request =======
// Creates approval requests for actions that need permission
// Optionally pass resource_id to request for a specific resource,
// or leave empty to create requests for ALL resources needing approval
router.post('/request', (req, res) => {
  try {
    const { resource_id } = req.body;
    const results = [];

    if (resource_id) {
      // Single resource
      const resource = getResourceById(resource_id);
      if (!resource) {
        return res.status(404).json({ error: `Resource ${resource_id} not found` });
      }
      const analysis = analyzeResource(resource);
      if (analysis.permission === 'REQUIRES_APPROVAL') {
        const approval = createApproval(analysis, resource);
        results.push(approval);
      } else {
        return res.json({
          message: `Resource ${resource_id} does not require approval (permission: ${analysis.permission})`,
          analysis
        });
      }
    } else {
      // All resources that need approval
      const resources = getResources();
      const analyses = analyzeAll(resources);

      for (let i = 0; i < analyses.length; i++) {
        if (analyses[i].permission === 'REQUIRES_APPROVAL') {
          const approval = createApproval(analyses[i], resources[i]);
          results.push(approval);
        }
      }
    }

    res.json({
      approvals_created: results.length,
      approvals: results
    });
  } catch (error) {
    console.error('[Request] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======= POST /api/actions/execute/:id =======
// Execute an APPROVED action on real AWS
router.post('/execute/:id', async (req, res) => {
  try {
    const approval = getApproval(req.params.id);
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found' });
    }
    if (approval.status !== 'approved') {
      return res.status(400).json({
        error: `Cannot execute — approval status is "${approval.status}". Must be "approved".`
      });
    }

    const resource = getResourceById(approval.resource_id);
    let result;

    switch (approval.action) {
      // EC2 actions
      case 'DOWNSCALE':
      case 'UPSCALE':
        if (approval.resource_type === 'EC2') {
          result = await ec2Actions.modifyInstanceType(
            resource.resource_id, resource.name, approval.target_instance
          );
        } else if (approval.resource_type === 'RDS') {
          result = await rdsActions.modifyInstanceClass(
            resource.resource_id, resource.name, approval.target_instance
          );
        }
        break;

      case 'SCHEDULE':
        result = await ec2Actions.stopInstance(resource.resource_id, resource.name);
        break;

      case 'CONVERT_TO_SPOT':
        // Spot conversion requires launching a new instance — simplified here
        result = {
          action: 'CONVERT_TO_SPOT',
          mode: process.env.EXECUTE_MODE || 'dry_run',
          success: true,
          message: `Spot conversion for ${resource.resource_id} requires manual launch of spot replacement. Original can be terminated after.`
        };
        break;

      case 'SWITCH_FAMILY':
        if (resource.resource_type === 'EC2') {
          result = await ec2Actions.modifyInstanceType(
            resource.resource_id, resource.name, approval.target_instance
          );
        }
        break;

      // EBS actions
      case 'MIGRATE':
        if (approval.resource_type === 'EBS') {
          result = await ebsActions.migrateVolumeType(
            resource.resource_id, resource.name, 'gp3'
          );
        } else if (approval.resource_type === 'RDS') {
          result = await rdsActions.migrateStorageType(
            resource.resource_id, resource.name, 'gp3'
          );
        }
        break;

      case 'RESIZE':
        result = await ebsActions.resizeVolume(
          resource.resource_id, resource.name, approval.target_size_gb
        );
        break;

      case 'MOVE_STORAGE_CLASS':
        result = await ebsActions.migrateVolumeType(
          resource.resource_id, resource.name, 'sc1'
        );
        break;

      // RDS actions
      case 'DISABLE_MULTI_AZ':
        result = await rdsActions.disableMultiAZ(resource.resource_id, resource.name);
        break;

      case 'REDUCE_STORAGE':
        result = {
          action: 'REDUCE_STORAGE',
          mode: process.env.EXECUTE_MODE || 'dry_run',
          success: true,
          message: `RDS storage reduction for ${resource.resource_id} requires manual intervention (cannot shrink RDS storage via API)`
        };
        break;

      case 'BUY_RESERVED':
        result = {
          action: 'BUY_RESERVED',
          mode: process.env.EXECUTE_MODE || 'dry_run',
          success: true,
          message: `Reserved Instance purchase for ${resource.resource_id} requires manual purchase via AWS Console`
        };
        break;

      default:
        return res.status(400).json({ error: `Unknown action: ${approval.action}` });
    }

    markExecuted(req.params.id, result);

    res.json({
      approval_id: req.params.id,
      resource_id: approval.resource_id,
      action: approval.action,
      result
    });
  } catch (error) {
    console.error('[Execute] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/actions/log — execution history
router.get('/log', (req, res) => {
  res.json({ log: getExecutionLog() });
});

module.exports = router;
