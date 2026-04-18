// src/approvals/store.js
// In-memory approval queue — actions that require human permission go here

const { v4: uuidv4 } = require('uuid');

// In-memory store
const approvals = new Map();
const executionLog = [];

function createApproval(analysis, resource) {
  const id = uuidv4();
  const approval = {
    id,
    resource_id: resource.resource_id,
    resource_type: resource.resource_type,
    name: resource.name,
    environment: resource.environment,
    action: analysis.primary_action,
    target_instance: analysis.target_instance || null,
    current_cost: resource.monthly_cost_usd,
    estimated_savings: analysis.estimated_savings,
    reason: analysis.action_details,
    rules_triggered: analysis.rules_triggered,
    status: 'pending', // pending | approved | rejected | executed
    created_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    rejection_reason: null
  };

  approvals.set(id, approval);
  return approval;
}

function getApproval(id) {
  return approvals.get(id) || null;
}

function getAllApprovals(statusFilter = null) {
  let results = Array.from(approvals.values());
  if (statusFilter) {
    results = results.filter((a) => a.status === statusFilter);
  }
  return results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function approveAction(id, approvedBy = 'admin') {
  const approval = approvals.get(id);
  if (!approval) return null;
  if (approval.status !== 'pending') return { error: `Action already ${approval.status}` };

  approval.status = 'approved';
  approval.decided_at = new Date().toISOString();
  approval.decided_by = approvedBy;
  return approval;
}

function rejectAction(id, rejectedBy = 'admin', reason = '') {
  const approval = approvals.get(id);
  if (!approval) return null;
  if (approval.status !== 'pending') return { error: `Action already ${approval.status}` };

  approval.status = 'rejected';
  approval.decided_at = new Date().toISOString();
  approval.decided_by = rejectedBy;
  approval.rejection_reason = reason;
  return approval;
}

function markExecuted(id, result) {
  const approval = approvals.get(id);
  if (!approval) return null;

  approval.status = 'executed';
  approval.executed_at = new Date().toISOString();
  approval.execution_result = result;

  executionLog.push({
    approval_id: id,
    resource_id: approval.resource_id,
    action: approval.action,
    result,
    timestamp: approval.executed_at
  });

  return approval;
}

function logAutoExecution(resource, action, result) {
  const entry = {
    approval_id: null,
    resource_id: resource.resource_id,
    name: resource.name,
    action,
    permission: 'AUTO_EXECUTE',
    result,
    timestamp: new Date().toISOString()
  };
  executionLog.push(entry);
  return entry;
}

function getExecutionLog() {
  return [...executionLog].reverse();
}

function getStats() {
  const all = Array.from(approvals.values());
  return {
    total: all.length,
    pending: all.filter((a) => a.status === 'pending').length,
    approved: all.filter((a) => a.status === 'approved').length,
    rejected: all.filter((a) => a.status === 'rejected').length,
    executed: all.filter((a) => a.status === 'executed').length,
    total_auto_executions: executionLog.filter((e) => e.permission === 'AUTO_EXECUTE').length
  };
}

module.exports = {
  createApproval,
  getApproval,
  getAllApprovals,
  approveAction,
  rejectAction,
  markExecuted,
  logAutoExecution,
  getExecutionLog,
  getStats
};
