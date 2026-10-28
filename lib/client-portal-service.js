/**
 * Client portal service.
 *
 * Implements the operations required by the legacy client-portal API routes:
 * invitations, project read models, approvals/rejections and feedback.
 */

const { randomUUID } = require('crypto');
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(explicitClient) {
  const client = explicitClient || createAdminSupabaseClient();
  if (!client) throw new Error('Database connection failed');
  return client;
}

async function getClientAccountId(db, userId) {
  const { data, error } = await db
    .from('user_profiles')
    .select('client_account_id, is_client')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_client || !data.client_account_id) {
    throw new Error('Client access required');
  }
  return data.client_account_id;
}

async function assertClientProject(db, userId, projectId) {
  const accountId = await getClientAccountId(db, userId);
  const { data, error } = await db
    .from('projects')
    .select('id, account_id, name')
    .eq('id', projectId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Project not found or access denied');
  return data;
}

async function sendClientInvitation({ accountId, email, invitedBy, expiresInDays = 7 }) {
  const db = getDb();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Email is required');

  // Do not invite someone who already has an internal profile.
  const { data: existingProfile } = await db
    .from('user_profiles')
    .select('id')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle();
  if (existingProfile) {
    throw new Error('An internal user with this email already exists');
  }

  const { data: pendingInvite } = await db
    .from('client_portal_invitations')
    .select('id')
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle();
  if (pendingInvite) {
    throw new Error('A pending invitation already exists for this email');
  }

  const days = Math.max(1, Math.min(30, Number(expiresInDays) || 7));
  const token = randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('client_portal_invitations')
    .insert({
      account_id: accountId,
      email: normalizedEmail,
      token,
      status: 'pending',
      invited_by: invitedBy || null,
      expires_at: expiresAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAllClientFeedback() {
  const { data, error } = await getDb()
    .from('client_feedback')
    .select(
      `*,
       project:projects(id, name),
       client:user_profiles!client_user_id(id, name, email)`,
    )
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getClientProjects(userId) {
  const db = getDb();
  const accountId = await getClientAccountId(db, userId);

  const { data, error } = await db
    .from('projects')
    .select(
      `*,
       workflow_instances(id, status, current_node_id, workflow_templates(id, name)),
       client_feedback(id, satisfaction_score, submitted_at)`,
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data || []).map((project) => {
    const instances = project.workflow_instances || [];
    return {
      ...project,
      workflow_instance: Array.isArray(instances) ? instances[0] || null : instances,
    };
  });
}

async function getClientProjectById(userId, projectId) {
  const db = getDb();
  const accountId = await getClientAccountId(db, userId);

  const { data, error } = await db
    .from('projects')
    .select(
      `*,
       workflow_instances(*, workflow_templates(id, name))`,
    )
    .eq('id', projectId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const instances = data.workflow_instances || [];
  return {
    ...data,
    workflow_instance: Array.isArray(instances) ? instances[0] || null : instances,
  };
}

async function clientApproveProject({
  projectId,
  workflowInstanceId,
  clientUserId,
  notes = null,
  supabaseClient = null,
}) {
  const db = getDb(supabaseClient);
  await assertClientProject(db, clientUserId, projectId);

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .select('*')
    .eq('id', workflowInstanceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (instanceError) throw instanceError;
  if (!instance) throw new Error('Workflow instance not found for this project');

  const fromNodeId = instance.current_node_id;
  if (!fromNodeId) throw new Error('Workflow instance has no current node');

  const { data: connections } = await db
    .from('workflow_connections')
    .select('to_node_id')
    .eq('from_node_id', fromNodeId)
    .limit(1);

  const hasNext = Boolean(connections && connections.length > 0);
  const nextNodeId = hasNext ? connections[0].to_node_id : fromNodeId;

  const { data: nextNode } = hasNext
    ? await db
        .from('workflow_nodes')
        .select('id, node_type')
        .eq('id', nextNodeId)
        .maybeSingle()
    : { data: null };

  const isComplete = !hasNext || !nextNode || nextNode.node_type === 'end';
  const now = new Date().toISOString();

  const { data: historyEntry, error: historyError } = await db
    .from('workflow_history')
    .insert({
      workflow_instance_id: workflowInstanceId,
      from_node_id: fromNodeId || nextNodeId,
      to_node_id: nextNodeId || fromNodeId,
      transitioned_by: clientUserId,
      notes: notes || 'Approved by client',
      transition_type: 'normal',
    })
    .select()
    .single();
  if (historyError) throw historyError;

  if (fromNodeId) {
    await db
      .from('workflow_active_steps')
      .update({ status: 'completed', completed_at: now })
      .eq('workflow_instance_id', workflowInstanceId)
      .eq('node_id', fromNodeId)
      .eq('status', 'active');
  }

  if (hasNext) {
    await db.from('workflow_active_steps').insert({
      workflow_instance_id: workflowInstanceId,
      node_id: nextNodeId,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? now : null,
    });
  }

  await db
    .from('workflow_instances')
    .update({
      current_node_id: nextNodeId,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? now : null,
    })
    .eq('id', workflowInstanceId);

  logger.info('Client approved project', { projectId, workflowInstanceId, clientUserId });

  return {
    success: true,
    workflow_instance_id: workflowInstanceId,
    current_node_id: nextNodeId,
    history_entry: historyEntry,
  };
}

async function clientRejectProject({
  projectId,
  workflowInstanceId,
  clientUserId,
  notes,
  issues = [],
  supabaseClient = null,
}) {
  const db = getDb(supabaseClient);
  await assertClientProject(db, clientUserId, projectId);

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .select('*')
    .eq('id', workflowInstanceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (instanceError) throw instanceError;
  if (!instance) throw new Error('Workflow instance not found for this project');

  const nodeId = instance.current_node_id;
  if (!nodeId) throw new Error('Workflow instance has no current node');

  const { data: historyEntry, error: historyError } = await db
    .from('workflow_history')
    .insert({
      workflow_instance_id: workflowInstanceId,
      from_node_id: nodeId,
      to_node_id: nodeId,
      transitioned_by: clientUserId,
      notes: notes || 'Rejected by client',
      transition_type: 'rejection',
      out_of_order: false,
    })
    .select()
    .single();
  if (historyError) throw historyError;

  let issuesLogged = 0;
  if (Array.isArray(issues) && issues.length > 0) {
    const issueRows = issues
      .filter((issue) => typeof issue === 'string' && issue.trim().length > 0)
      .map((issue) => ({
        project_id: projectId,
        content: issue.trim(),
        status: 'open',
        created_by: clientUserId,
        workflow_history_id: historyEntry.id,
      }));

    if (issueRows.length > 0) {
      const { error: issuesError } = await db.from('project_issues').insert(issueRows);
      if (issuesError) throw issuesError;
      issuesLogged = issueRows.length;
    }
  }

  logger.info('Client rejected project', {
    projectId,
    workflowInstanceId,
    clientUserId,
    issuesLogged,
  });

  return {
    success: true,
    workflow_instance_id: workflowInstanceId,
    history_entry: historyEntry,
    issues_logged: issuesLogged,
  };
}

async function submitClientFeedback({
  projectId,
  clientUserId,
  satisfactionScore = null,
  whatWentWell = null,
  whatNeedsImprovement = null,
  workflowHistoryId = null,
}) {
  const db = getDb();
  await assertClientProject(db, clientUserId, projectId);

  const { data, error } = await db
    .from('client_feedback')
    .insert({
      project_id: projectId,
      client_user_id: clientUserId,
      satisfaction_score: satisfactionScore ?? null,
      what_went_well: whatWentWell ?? null,
      what_needs_improvement: whatNeedsImprovement ?? null,
      workflow_history_id: workflowHistoryId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  sendClientInvitation,
  getAllClientFeedback,
  getClientProjects,
  getClientProjectById,
  clientApproveProject,
  clientRejectProject,
  submitClientFeedback,
};
