// src/actions/ec2.js
// AWS EC2 actions — terminate, stop, start, modify instance type

const { EC2Client, TerminateInstancesCommand, StopInstancesCommand, StartInstancesCommand,
  ModifyInstanceAttributeCommand, DescribeInstancesCommand, CreateImageCommand } = require('@aws-sdk/client-ec2');

const EXECUTE_MODE = process.env.EXECUTE_MODE || 'dry_run';

function getClient() {
  return new EC2Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
}

// ======= TERMINATE (auto-execute, no permission needed) =======
async function terminateInstance(instanceId, resourceName) {
  const action = {
    action: 'TERMINATE',
    resource_id: instanceId,
    name: resourceName,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would terminate EC2 instance ${instanceId} (${resourceName})`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would terminate ${instanceId}` };
  }

  try {
    const client = getClient();

    // Step 1: Create backup AMI before terminating
    console.log(`[LIVE] Creating backup AMI for ${instanceId}...`);
    const amiResult = await client.send(new CreateImageCommand({
      InstanceId: instanceId,
      Name: `backup-before-terminate-${instanceId}-${Date.now()}`,
      NoReboot: true
    }));

    // Step 2: Terminate
    console.log(`[LIVE] Terminating EC2 instance ${instanceId} (${resourceName})`);
    const result = await client.send(new TerminateInstancesCommand({
      InstanceIds: [instanceId]
    }));

    return {
      ...action,
      mode: 'live',
      success: true,
      backup_ami: amiResult.ImageId,
      previous_state: result.TerminatingInstances?.[0]?.PreviousState?.Name,
      current_state: result.TerminatingInstances?.[0]?.CurrentState?.Name,
      message: `Terminated ${instanceId}. Backup AMI: ${amiResult.ImageId}`
    };
  } catch (error) {
    console.error(`[ERROR] Failed to terminate ${instanceId}:`, error.message);
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= STOP (for scheduling) =======
async function stopInstance(instanceId, resourceName) {
  const action = { action: 'STOP', resource_id: instanceId, name: resourceName, timestamp: new Date().toISOString() };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would stop EC2 instance ${instanceId}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would stop ${instanceId}` };
  }

  try {
    const client = getClient();
    const result = await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    return {
      ...action, mode: 'live', success: true,
      previous_state: result.StoppingInstances?.[0]?.PreviousState?.Name,
      message: `Stopped ${instanceId}`
    };
  } catch (error) {
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= START =======
async function startInstance(instanceId, resourceName) {
  const action = { action: 'START', resource_id: instanceId, name: resourceName, timestamp: new Date().toISOString() };

  if (EXECUTE_MODE === 'dry_run') {
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would start ${instanceId}` };
  }

  try {
    const client = getClient();
    await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    return { ...action, mode: 'live', success: true, message: `Started ${instanceId}` };
  } catch (error) {
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= DOWNSCALE / UPSCALE (requires approval) =======
async function modifyInstanceType(instanceId, resourceName, newInstanceType) {
  const action = {
    action: 'MODIFY_INSTANCE_TYPE',
    resource_id: instanceId,
    name: resourceName,
    new_type: newInstanceType,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would change ${instanceId} to ${newInstanceType}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would change ${instanceId} to ${newInstanceType}` };
  }

  try {
    const client = getClient();

    // Step 1: Stop the instance (required for type change)
    console.log(`[LIVE] Stopping ${instanceId} for type change...`);
    await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));

    // Wait for stopped state
    console.log(`[LIVE] Waiting for instance to stop...`);
    await waitForState(client, instanceId, 'stopped');

    // Step 2: Modify instance type
    console.log(`[LIVE] Changing ${instanceId} to ${newInstanceType}...`);
    await client.send(new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      InstanceType: { Value: newInstanceType }
    }));

    // Step 3: Start it back up
    console.log(`[LIVE] Starting ${instanceId}...`);
    await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

    return {
      ...action, mode: 'live', success: true,
      message: `Changed ${instanceId} from current type to ${newInstanceType} and restarted`
    };
  } catch (error) {
    console.error(`[ERROR] Failed to modify ${instanceId}:`, error.message);
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

async function waitForState(client, instanceId, targetState, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const result = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    if (state === targetState) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timeout waiting for ${instanceId} to reach ${targetState}`);
}

module.exports = { terminateInstance, stopInstance, startInstance, modifyInstanceType };
