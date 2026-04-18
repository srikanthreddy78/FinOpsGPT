// src/actions/rds.js
// AWS RDS actions — downscale, upscale, disable multi-az, migrate storage

const { RDSClient, ModifyDBInstanceCommand, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');

const EXECUTE_MODE = process.env.EXECUTE_MODE || 'dry_run';

function getClient() {
  return new RDSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
}

// ======= DOWNSCALE / UPSCALE instance class (requires approval) =======
async function modifyInstanceClass(dbInstanceId, resourceName, newClass) {
  const action = {
    action: 'MODIFY_DB_INSTANCE_CLASS',
    resource_id: dbInstanceId,
    name: resourceName,
    new_class: newClass,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would change ${dbInstanceId} to ${newClass}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would change ${dbInstanceId} to ${newClass}` };
  }

  try {
    const client = getClient();

    console.log(`[LIVE] Modifying RDS instance ${dbInstanceId} to ${newClass}...`);
    await client.send(new ModifyDBInstanceCommand({
      DBInstanceIdentifier: dbInstanceId,
      DBInstanceClass: newClass,
      ApplyImmediately: false // Apply during next maintenance window for safety
    }));

    return {
      ...action, mode: 'live', success: true,
      message: `Scheduled ${dbInstanceId} change to ${newClass}. Will apply during next maintenance window.`
    };
  } catch (error) {
    console.error(`[ERROR] Failed to modify ${dbInstanceId}:`, error.message);
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= DISABLE MULTI-AZ (requires approval) =======
async function disableMultiAZ(dbInstanceId, resourceName) {
  const action = {
    action: 'DISABLE_MULTI_AZ',
    resource_id: dbInstanceId,
    name: resourceName,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would disable Multi-AZ on ${dbInstanceId}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would disable Multi-AZ on ${dbInstanceId}` };
  }

  try {
    const client = getClient();

    console.log(`[LIVE] Disabling Multi-AZ on ${dbInstanceId}...`);
    await client.send(new ModifyDBInstanceCommand({
      DBInstanceIdentifier: dbInstanceId,
      MultiAZ: false,
      ApplyImmediately: true
    }));

    return {
      ...action, mode: 'live', success: true,
      message: `Disabled Multi-AZ on ${dbInstanceId}. Saves ~50% on this instance.`
    };
  } catch (error) {
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

// ======= MIGRATE STORAGE TYPE (requires approval) =======
async function migrateStorageType(dbInstanceId, resourceName, targetStorageType) {
  const action = {
    action: 'MIGRATE_DB_STORAGE',
    resource_id: dbInstanceId,
    name: resourceName,
    target_storage: targetStorageType,
    timestamp: new Date().toISOString()
  };

  if (EXECUTE_MODE === 'dry_run') {
    console.log(`[DRY_RUN] Would migrate ${dbInstanceId} storage to ${targetStorageType}`);
    return { ...action, mode: 'dry_run', success: true, message: `DRY_RUN: Would migrate storage to ${targetStorageType}` };
  }

  try {
    const client = getClient();

    console.log(`[LIVE] Migrating ${dbInstanceId} storage to ${targetStorageType}...`);
    await client.send(new ModifyDBInstanceCommand({
      DBInstanceIdentifier: dbInstanceId,
      StorageType: targetStorageType,
      ApplyImmediately: false
    }));

    return {
      ...action, mode: 'live', success: true,
      message: `Scheduled ${dbInstanceId} storage migration to ${targetStorageType}`
    };
  } catch (error) {
    return { ...action, mode: 'live', success: false, error: error.message };
  }
}

module.exports = { modifyInstanceClass, disableMultiAZ, migrateStorageType };
