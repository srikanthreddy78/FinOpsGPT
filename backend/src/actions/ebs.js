// src/actions/ebs.js
// AWS EBS actions — delete unattached volumes, migrate types, resize

const { EC2Client, DeleteVolumeCommand, ModifyVolumeCommand,
  CreateSnapshotCommand, DescribeVolumesCommand } = require('@aws-sdk/client-ec2');

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

// ======= DELETE unattached volume (auto-execute, no permission needed) =======
async function deleteVolume(volumeId, resourceName) {
  const action = {
    action: 'DELETE_VOLUME',
    resource_id: volumeId,
    name: resourceName,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would snapshot then delete EBS volume ${volumeId} (${resourceName})`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would delete ${volumeId}` };
  }

  try {
    const client = getClient();

    // Step 1: Create snapshot backup before deletion
    console.log(`[LIVE] Creating snapshot of ${volumeId} before deletion...`);
    const snapshot = await client.send(new CreateSnapshotCommand({
      VolumeId: volumeId,
      Description: `Backup before CloudPulse agent deletion — ${resourceName} — ${new Date().toISOString()}`
    }));

    // Step 2: Delete the volume
    console.log(`[LIVE] Deleting EBS volume ${volumeId} (${resourceName})`);
    await client.send(new DeleteVolumeCommand({ VolumeId: volumeId }));

    return {
      ...action, mode: 'live', success: true,
      backup_snapshot: snapshot.SnapshotId,
      message: `Deleted ${volumeId}. Backup snapshot: ${snapshot.SnapshotId}`
    };
  } catch (error) {
    console.error(`[ERROR] Failed to delete ${volumeId}:`, error.message);
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= MIGRATE volume type (requires approval) =======
async function migrateVolumeType(volumeId, resourceName, targetType, targetIops = null) {
  const action = {
    action: 'MIGRATE_VOLUME_TYPE',
    resource_id: volumeId,
    name: resourceName,
    target_type: targetType,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would migrate ${volumeId} to ${targetType}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would migrate ${volumeId} to ${targetType}` };
  }

  try {
    const client = getClient();

    const params = {
      VolumeId: volumeId,
      VolumeType: targetType
    };

    // gp3 baseline is 3000 IOPS — only set IOPS if target needs more
    if (targetType === 'gp3' && targetIops && targetIops > 3000) {
      params.Iops = targetIops;
    }

    console.log(`[LIVE] Migrating ${volumeId} to ${targetType}...`);
    await client.send(new ModifyVolumeCommand(params));

    return {
      ...action, mode: 'live', success: true,
      message: `Migrated ${volumeId} to ${targetType}. Change takes effect immediately, no downtime.`
    };
  } catch (error) {
    console.error(`[ERROR] Failed to migrate ${volumeId}:`, error.message);
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= RESIZE volume (requires approval) =======
async function resizeVolume(volumeId, resourceName, newSizeGb) {
  const action = {
    action: 'RESIZE_VOLUME',
    resource_id: volumeId,
    name: resourceName,
    new_size_gb: newSizeGb,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would resize ${volumeId} to ${newSizeGb}GB`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would resize ${volumeId} to ${newSizeGb}GB` };
  }

  try {
    const client = getClient();

    // NOTE: EBS volumes can only be INCREASED in size, not decreased.
    // To shrink, you'd need to create a new smaller volume and copy data.
    // This action handles the increase case.
    console.log(`[LIVE] Resizing ${volumeId} to ${newSizeGb}GB...`);
    await client.send(new ModifyVolumeCommand({
      VolumeId: volumeId,
      Size: newSizeGb
    }));

    return {
      ...action, mode: 'live', success: true,
      message: `Resized ${volumeId} to ${newSizeGb}GB`
    };
  } catch (error) {
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

module.exports = { deleteVolume, migrateVolumeType, resizeVolume };
