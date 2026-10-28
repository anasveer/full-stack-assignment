/**
 * Workflow execution service.
 *
 * Backs the workflow inbox (my projects / my approvals / progress / start)
 * used by the projects UI. All functions accept an explicit Supabase client
 * and fall back to the admin client.
 */

const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(explicitClient) {
  const client = explicitClient || createAdminSupabaseClient();
  if (!client) throw new Error('Database connection failed');
  return client;
}

function snapshotNode(instance, nodeId) {
  const snapshot = (instance && instance.started_snapshot) || {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return nodes.find((node) => node.id === nodeId) || null;
}

async function getActiveSteps(client, workflowInstanceId) {
  const db = getDb(client);
  const { data, error } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('workflow_instance_id', workflowInstanceId)
    .eq('status', 'active');
  if (error) throw error;
  return data || [];
}

async function getAllActiveAndWaitingSteps(client, workflowInstanceId) {
  const db = getDb(client);
  const { data, error } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('workflow_instance_id', workflowInstanceId);
  if (error) throw error;
  return data || [];
}

async function isWorkflowComplete(client, workflowInstanceId) {
  const db = getDb(client);
  const { data: instance } = await db
    .from('workflow_instances')
    .select('status')
    .eq('id', workflowInstanceId)
    .maybeSingle();
  if (!instance) return true;
  if (instance.status === 'completed') return true;

  const { count } = await db
    .from('workflow_active_steps')
    .select('id', { count: 'exact', head: true })
    .eq('workflow_instance_id', workflowInstanceId)
    .eq('status', 'active');
  return (count || 0) === 0;
}

async function getUserPendingApprovals(client, userId) {
  const db = getDb(client);

  const { data: steps, error } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('status', 'active');
  if (error) throw error;
  if (!steps || steps.length === 0) return [];

  const instanceIds = Array.from(new Set(steps.map((step) => step.workflow_instance_id)));
  const { data: instances } = await db
    .from('workflow_instances')
    .select('*')
    .in('id', instanceIds)
    .eq('status', 'active');
  const instanceMap = new Map((instances || []).map((instance) => [instance.id, instance]));

  const projectIds = Array.from(
    new Set((instances || []).map((instance) => instance.project_id).filter(Boolean)),
  );
  const { data: projects } = projectIds.length
    ? await db
        .from('projects')
        .select('id, name, description, status, priority, account_id, accounts(id, name)')
        .in('id', projectIds)
    : { data: [] };
  const projectMap = new Map((projects || []).map((project) => [project.id, project]));

  const { data: userRoles } = await db
    .from('user_roles')
    .select('role_id')
    .eq('user_id', userId);
  const roleIds = new Set((userRoles || []).map((row) => row.role_id));

  const assigneeIds = Array.from(
    new Set(steps.map((step) => step.assigned_user_id).filter(Boolean)),
  );
  const { data: users } = assigneeIds.length
    ? await db.from('user_profiles').select('id, name, email').in('id', assigneeIds)
    : { data: [] };
  const userMap = new Map((users || []).map((user) => [user.id, user]));

  const approvals = [];
  for (const step of steps) {
    const instance = instanceMap.get(step.workflow_instance_id);
    if (!instance) continue;

    const node = snapshotNode(instance, step.node_id);
    if (!node || node.node_type !== 'approval') continue;

    const directlyAssigned = step.assigned_user_id === userId;
    const roleAssigned =
      !step.assigned_user_id && node.entity_id && roleIds.has(node.entity_id);
    if (!directlyAssigned && !roleAssigned) continue;

    const project = projectMap.get(instance.project_id) || null;
    approvals.push({
      ...instance,
      workflow_nodes: { id: node.id, label: node.label, node_type: node.node_type },
      projects: project ? { ...project, account: project.accounts || null } : null,
      active_step_id: step.id,
      current_node_id: step.node_id,
      assigned_user: step.assigned_user_id ? userMap.get(step.assigned_user_id) || null : null,
    });
  }

  return approvals;
}

async function getUserActiveProjects(client, userId) {
  const db = getDb(client);

  const { data: assignments, error } = await db
    .from('project_assignments')
    .select(
      `*,
       projects(
         id, name, description, status, priority, created_at, account_id,
         estimated_hours, actual_hours, end_date, start_date,
         accounts(id, name)
       )`,
    )
    .eq('user_id', userId)
    .is('removed_at', null);
  if (error) throw error;

  const { data: profile } = await db
    .from('user_profiles')
    .select('id, name, email')
    .eq('id', userId)
    .maybeSingle();

  return (assignments || [])
    .map((assignment) => ({
      ...assignment,
      assigned_user: profile || undefined,
    }))
    .filter((assignment) => assignment.projects && assignment.projects.status !== 'complete');
}

async function progressWorkflowStep(
  client,
  workflowInstanceId,
  activeStepId,
  userId,
  decision,
  feedback,
  formResponseId,
  assignedUserId,
  _formData,
  assignedUsersPerNode,
) {
  const db = getDb(client);
  const now = new Date().toISOString();

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .select('*')
    .eq('id', workflowInstanceId)
    .maybeSingle();
  if (instanceError) return { success: false, error: instanceError.message };
  if (!instance) return { success: false, error: 'Workflow instance not found' };

  let step = null;
  if (activeStepId) {
    const { data } = await db
      .from('workflow_active_steps')
      .select('*')
      .eq('id', activeStepId)
      .eq('workflow_instance_id', workflowInstanceId)
      .maybeSingle();
    step = data;
  }
  if (!step && instance.current_node_id) {
    const { data } = await db
      .from('workflow_active_steps')
      .select('*')
      .eq('workflow_instance_id', workflowInstanceId)
      .eq('node_id', instance.current_node_id)
      .eq('status', 'active')
      .maybeSingle();
    step = data;
  }

  const fromNodeId = (step && step.node_id) || instance.current_node_id;
  if (!fromNodeId) {
    return { success: false, error: 'Workflow instance has no current node' };
  }

  if (decision === 'reject' || decision === 'rejected') {
    if (step) {
      await db
        .from('workflow_active_steps')
        .update({ status: 'completed', completed_at: now })
        .eq('id', step.id);
    }

    const { data: history, error } = await db
      .from('workflow_history')
      .insert({
        workflow_instance_id: workflowInstanceId,
        from_node_id: fromNodeId,
        to_node_id: fromNodeId,
        transitioned_by: userId,
        notes: feedback || 'Rejected',
        transition_type: 'rejection',
        form_response_id: formResponseId || null,
      })
      .select()
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, nextNode: null, newActiveSteps: [], historyEntry: history };
  }

  if (step) {
    await db
      .from('workflow_active_steps')
      .update({ status: 'completed', completed_at: now })
      .eq('id', step.id);
  }

  const { data: connections } = fromNodeId
    ? await db.from('workflow_connections').select('to_node_id').eq('from_node_id', fromNodeId)
    : { data: [] };
  const nextIds = Array.from(
    new Set((connections || []).map((connection) => connection.to_node_id).filter(Boolean)),
  );
  const { data: nextNodes } = nextIds.length
    ? await db.from('workflow_nodes').select('*').in('id', nextIds)
    : { data: [] };
  const nodes = nextNodes || [];

  const newActiveSteps = [];
  for (const node of nodes) {
    const isEnd = node.node_type === 'end';
    const assigned =
      (assignedUsersPerNode && assignedUsersPerNode[node.id]) || assignedUserId || null;
    const { data: created } = await db
      .from('workflow_active_steps')
      .insert({
        workflow_instance_id: workflowInstanceId,
        node_id: node.id,
        assigned_user_id: assigned || null,
        status: isEnd ? 'completed' : 'active',
        completed_at: isEnd ? now : null,
      })
      .select()
      .single();
    if (created) newActiveSteps.push(created);
  }

  const firstNext = nodes[0] || null;
  const isComplete = nodes.length === 0 || nodes.every((node) => node.node_type === 'end');

  await db
    .from('workflow_instances')
    .update({
      current_node_id: firstNext ? firstNext.id : fromNodeId,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? now : null,
    })
    .eq('id', workflowInstanceId);

  const { data: history, error: historyError } = await db
    .from('workflow_history')
    .insert({
      workflow_instance_id: workflowInstanceId,
      from_node_id: fromNodeId,
      to_node_id: firstNext ? firstNext.id : fromNodeId,
      transitioned_by: userId,
      notes: feedback || null,
      transition_type: 'normal',
      form_response_id: formResponseId || null,
    })
    .select()
    .single();
  if (historyError) return { success: false, error: historyError.message };

  return { success: true, nextNode: firstNext, newActiveSteps, historyEntry: history };
}

async function startWorkflowForProject(client, projectId, workflowTemplateId, userId) {
  const db = getDb(client);

  const { data: project, error: projectError } = await db
    .from('projects')
    .select('id, account_id')
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) return { success: false, error: projectError.message };
  if (!project) return { success: false, error: 'Project not found' };

  const { data: template, error: templateError } = await db
    .from('workflow_templates')
    .select('*')
    .eq('id', workflowTemplateId)
    .maybeSingle();
  if (templateError) return { success: false, error: templateError.message };
  if (!template) return { success: false, error: 'Workflow template not found' };
  if (!template.is_active) {
    return { success: false, error: 'Workflow template not found or inactive' };
  }

  const { data: existing } = await db
    .from('workflow_instances')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (existing) return { success: false, error: 'Project already has an active workflow' };

  const { data: nodes, error: nodesError } = await db
    .from('workflow_nodes')
    .select('*')
    .eq('workflow_template_id', workflowTemplateId)
    .order('position_x', { ascending: true });
  if (nodesError) return { success: false, error: nodesError.message };
  if (!nodes || nodes.length === 0) {
    return { success: false, error: 'Workflow template has no nodes' };
  }

  const startNode = nodes.find((node) => node.node_type === 'start') || nodes[0];
  const { data: connections } = await db
    .from('workflow_connections')
    .select('*')
    .eq('workflow_template_id', workflowTemplateId);

  const isComplete = startNode.node_type === 'end';
  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .insert({
      workflow_template_id: workflowTemplateId,
      project_id: projectId,
      current_node_id: startNode.id,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? new Date().toISOString() : null,
      started_snapshot: { template, nodes, connections: connections || [] },
    })
    .select()
    .single();
  if (instanceError) return { success: false, error: instanceError.message };

  await db.from('workflow_active_steps').insert({
    workflow_instance_id: instance.id,
    node_id: startNode.id,
    assigned_user_id: userId || null,
    status: isComplete ? 'completed' : 'active',
    completed_at: isComplete ? new Date().toISOString() : null,
  });

  logger.info('Workflow started for project', {
    workflowInstanceId: instance.id,
    projectId,
    workflowTemplateId,
  });

  return { success: true, workflowInstanceId: instance.id };
}

module.exports = {
  getActiveSteps,
  getAllActiveAndWaitingSteps,
  isWorkflowComplete,
  getUserPendingApprovals,
  getUserActiveProjects,
  progressWorkflowStep,
  startWorkflowForProject,
};
